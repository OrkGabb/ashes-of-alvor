#!/usr/bin/env python3
"""
Compilador da cidade 'Cinzas de Alvor' a partir de assets CC0 (Kenney Fantasy Town Kit, KayKit).

Entrada: tools/city_layout.py (o mapa autoral, escrito com a API desta classe City).
Saída:   public/assets/city/city.json  — fonte única do layout para o navegador e para os testes:
           models     chave -> url do modelo copiado para public/assets/kits/
           instances  {m, p, r, s, pal?, dyn?, tag} (s = escala uniforme ou [sx, sy, sz])
           colliders  AABBs na altura do corpo (x/z em metros)
           zones      áreas com nome (interiores, fachadas, marcos visitáveis)
           roofs      projeções de telhado (chuva e acústica)
           lights     âncoras de luz (o cliente escolhe quais viram PointLight reais)
           nav        nós e arestas para NPCs; anchors; collectibles; ground (calçamento)
         public/assets/kits/**  — só os modelos realmente usados (+ texturas e .bin)

Coordenadas: as do Three.js (Y para cima, norte = -Z), em metros.
Convenção Kenney (medida nos GLBs): célula 1x1 centrada na origem, painel de parede na borda +X,
altura 1. Escala da cidade: 1 célula = K metros.

Execução:
  python tools/build_city.py
"""
from __future__ import annotations

import importlib.util
import json
import zlib
import math
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
from gltf_bounds import Gltf  # noqa: E402
from footprint import body_points, footprint_boxes  # noqa: E402

SRC = ROOT / "assets_src"
KITS_OUT = ROOT / "public" / "assets" / "kits"
DETAIL_SPEC = ROOT / "public" / "textures" / "detail.json"
CITY_OUT = ROOT / "public" / "assets" / "city" / "city.json"

K = 2.8                 # metros por célula Kenney
KK = 0.8                # escala dos assets KayKit (personagem ~1,76 m)
WALL_T = 0.3            # espessura de colisão das paredes modulares
TRIANGLE_BUDGET = 850_000   # cidade + regiões extramuros ao sul (floresta e vegetação instanciadas)

KITS = {
    "kenney": {"dir": SRC / "kenney_town", "ext": ".glb", "extra": ["Textures/colormap.png"]},
    "dungeon": {"dir": SRC / "kaykit_dungeon", "ext": ".gltf", "extra": ["dungeon_texture.png"]},
    "forest": {"dir": SRC / "kaykit_forest", "ext": ".gltf", "extra": ["forest_texture.png"]},
    "adv": {"dir": SRC / "kaykit_adventurers" / "items", "ext": ".gltf", "extra": []},
    "pets": {"dir": SRC / "kenney_pets", "ext": ".glb", "extra": ["Textures/colormap.png"]},
}

# Paletas do colormap Kenney: (reboco das paredes, telhas[, vigas]). As células foram medidas pelos UVs dos módulos:
# reboco = coluna 3 / faixa 2, telha = coluna 3 / faixa 3, madeira das vigas = coluna 9 / faixa 3 (32 x 128 px cada).
PALETTES = {
    "creme_vermelho": ("#efe2c6", "#c9503f"),
    "creme_azul": ("#efe2c6", "#3f6fc9"),
    "creme_verde": ("#ece0c2", "#3f9a74"),
    "creme_laranja": ("#f0e0c0", "#d9783a"),
    "creme_roxo": ("#ebe0cc", "#7a54b8"),
    "ocre_azul": ("#e0bf86", "#35589e"),
    "ocre_vermelho": ("#dcb47a", "#b4413a"),
    "branco_azul": ("#f4f1ea", "#2f5fc8"),
    "branco_dourado": ("#f6f3ec", "#d8a83a"),
    "pedra": ("#a3a3a8", "#4a5a78", "#6c6c72"),
    "pedra_azul": ("#c2c2ca", "#3456a8", "#7c7c86"),
    "pedra_escura": ("#7a746e", "#5a4a3e"),
}
TIMBER_COLOR = "#7a4e32"
SWATCH_WALL = (96, 256, 128, 384)
SWATCH_ROOF = (96, 384, 128, 512)
SWATCH_TIMBER = (288, 384, 320, 512)
SWATCH_ROOF_HIGH = (32, 384, 64, 512)
# Vão visível de cada módulo de janela Kenney, em células: meia-largura, centro e meia-altura acima do piso
# do andar (medido por raycast no mundo montado). É o que o vidro, o brilho e o interior falso cobrem.
WINDOW_OPENINGS = {
    "wall-window-glass": (0.102, 0.5, 0.2), "wall-wood-window-glass": (0.102, 0.5, 0.2),
    "wall-window-shutters": (0.151, 0.5, 0.2), "wall-wood-window-shutters": (0.151, 0.5, 0.2),
    "wall-window-small": (0.062, 0.5, 0.2), "wall-window-round": (0.062, 0.5, 0.2),
    "wall-wood-window-small": (0.08, 0.5, 0.2), "wall-wood-window-round": (0.08, 0.5, 0.2),
    "wall-window-stone": (0.062, 0.5, 0.2), "wall-wood-window-stone": (0.062, 0.5, 0.2),
}
CHARACTER_MODELS = ("Rogue", "Rogue_Hooded", "Mage", "Barbarian", "Knight")

# Relevo fora da cidade — FONTE ÚNICA dos parâmetros. Sai em city.json -> terrain.hill; o navegador (world.js,
# buildGround) e o teste (test_city.py, terrain_mesh_height) leem dali. Altura de um vértice da malha:
#   base + f * (rise + sin(x * freqX) * cos(z * freqZ) * amp),  f = min(1, dWall / ramp) ** power
# (dWall = distância para fora do retângulo terrain), f multiplicado por clamp(dFz / blend) de cada flatZone.
# A malha é um plano de 'size' metros com round(size / cell) segmentos: entre vértices a altura é a interpolação
# linear do triângulo (diagonal do quad do PlaneGeometry do Three.js), não a fórmula contínua.
TERRAIN_HILL = {"base": -0.03, "ramp": 26.0, "power": 1.5, "rise": 5.0, "amp": 4.0, "freqX": 0.07, "freqZ": 0.09,
                "cell": 3.0, "blend": 12.0}

# Modelos que o cliente carrega em tempo de execução (inimigos, fauna viva, armas empunhadas), exportados mesmo
# sem instância na cidade. Saem em city.json -> runtimeModels {chave: url} (não entram em 'models', que o
# world.js funde na geometria estática).
RUNTIME_MODELS = (
    ("adv", "sword_1handed"), ("adv", "staff"),
    ("pets", "animal-hog"), ("pets", "animal-dog"), ("pets", "animal-deer"), ("pets", "animal-fox"), ("pets", "animal-bunny"),
    ("dungeon", "sword_shield_broken"),
)
ENEMIES_JSON = ROOT / "public" / "data" / "enemies.json"

# Rotação em Y no padrão do Three.js: (x, z) -> (x cos + z sin, -x sin + z cos).
# A borda +X do módulo aponta para o lado indicado.
SIDE_ROT = {"E": 0.0, "N": math.pi / 2, "W": math.pi, "S": -math.pi / 2}
SIDE_VEC = {"E": (1, 0), "W": (-1, 0), "N": (0, -1), "S": (0, 1)}


def rot_y(x: float, z: float, a: float) -> tuple[float, float]:
    c, s = math.cos(a), math.sin(a)
    return x * c + z * s, -x * s + z * c


@dataclass
class Aabb:
    minX: float
    maxX: float
    minZ: float
    maxZ: float
    minY: float = 0.0
    maxY: float = 3.0

    def as_dict(self, label: str) -> dict:
        return {"label": label, "minX": round(self.minX, 3), "maxX": round(self.maxX, 3), "minZ": round(self.minZ, 3),
                "maxZ": round(self.maxZ, 3), "minY": round(self.minY, 3), "maxY": round(self.maxY, 3)}


@dataclass
class Building:
    key: str
    x0: float
    z0: float
    W: int
    D: int
    floors: int
    box: Aabb
    interior: bool
    doors: list[tuple[str, float, float]] = field(default_factory=list)   # (lado, x, z) do centro do vão


class City:
    def __init__(self) -> None:
        self.models: dict[str, dict] = {}
        self.instances: list[dict] = []
        self.colliders: list[dict] = []
        self.zones: list[dict] = []
        self.roofs: list[dict] = []
        self.lights: list[dict] = []
        self.glows: list[dict] = []
        self.anchors: dict[str, dict] = {}
        self.collectibles: dict[str, dict] = {}
        self.interactables: list[dict] = []
        self.windows: list[dict] = []
        self.doors: list[dict] = []
        self.gates: list[dict] = []
        self.terrain: dict = {}
        self.flat_zones: list[dict] = []
        self.nodes: dict[str, dict] = {}
        self.edges: list[tuple[str, str]] = []
        self.cobble: list[dict] = []
        self.dirt: list[dict] = []
        self.water: list[dict] = []
        self.enemy_spawns: list[dict] = []
        self.respawns: dict[str, dict] = {}
        self.fauna_list: list[dict] = []
        self.particles: list[dict] = []
        self.buildings: dict[str, Building] = {}
        self.bounds = {"minX": -60.0, "maxX": 60.0, "minZ": -60.0, "maxZ": 60.0}
        self.walk = dict(self.bounds)
        self.spawn = {"x": 0.0, "z": 0.0, "yaw": 0.0}
        self._bounds_cache: dict[str, tuple] = {}

    # -- modelos ---------------------------------------------------------------
    def model(self, kit: str, name: str) -> str:
        key = f"{kit}/{name}"
        if key not in self.models:
            spec = KITS[kit]
            path = spec["dir"] / f"{name}{spec['ext']}"
            if not path.is_file():
                raise SystemExit(f"[ERRO] modelo inexistente: {path}")
            g = Gltf(path)
            lo, hi = g.bounds()
            self.models[key] = {
                "url": f"./assets/kits/{kit}/{name}{spec['ext']}",
                "kit": kit,
                "lo": [round(float(v), 4) for v in lo],
                "hi": [round(float(v), 4) for v in hi],
                "tris": g.triangles(),
                "_src": str(path),
            }
        return key

    def place(self, kit: str, name: str, x: float, y: float, z: float, r: float = 0.0, s=1.0, *, pal: str | None = None,
              tag: str = "", dyn: str | None = None, collide: str | None = None, pad: float = 0.0, cast: bool = True,
              hinge: dict | None = None) -> dict:
        key = self.model(kit, name)
        inst: dict = {"m": key, "p": [round(x, 4), round(y, 4), round(z, 4)], "r": round(r, 5), "s": s}
        if hinge:
            # Parte articulada (porta, portão, tampa de baú): o cliente separa o nó e gira no pivô dele
            inst["hinge"] = hinge
        if pal:
            inst["pal"] = pal
        if tag:
            inst["tag"] = tag
        if dyn:
            inst["dyn"] = dyn
        if not cast:
            inst["noShadow"] = 1
        self.instances.append(inst)
        if collide:
            self.collide_instance(inst, collide, pad)
        return inst

    def place_centered(self, kit: str, name: str, x: float, y: float, z: float, r: float = 0.0, s=1.0, **kw) -> dict:
        """Como place(), mas (x, z) é o centro do modelo e não a origem dele.

        Módulos de borda do Kenney (cerca, sebe, parede) têm o painel deslocado na borda +X da célula:
        posicionar pela origem joga o visual ~1,3 m para o lado e o colisor escrito à mão fica no vazio.
        """
        key = self.model(kit, name)
        m = self.models[key]
        sx, _sy, sz = (s, s, s) if not isinstance(s, list) else s
        cx = (m["lo"][0] + m["hi"][0]) * 0.5 * sx
        cz = (m["lo"][2] + m["hi"][2]) * 0.5 * sz
        ox, oz = rot_y(cx, cz, r)
        return self.place(kit, name, x - ox, y, z - oz, r, s, **kw)

    def instance_aabb(self, inst: dict) -> Aabb:
        m = self.models[inst["m"]]
        lo, hi = m["lo"], m["hi"]
        s = inst["s"]
        sx, sy, sz = (s, s, s) if not isinstance(s, list) else s
        xs, zs = [], []
        for lx in (lo[0] * sx, hi[0] * sx):
            for lz in (lo[2] * sz, hi[2] * sz):
                wx, wz = rot_y(lx, lz, inst["r"])
                xs.append(inst["p"][0] + wx)
                zs.append(inst["p"][2] + wz)
        ys = sorted((lo[1] * sy, hi[1] * sy))
        return Aabb(min(xs), max(xs), min(zs), max(zs), inst["p"][1] + ys[0], inst["p"][1] + ys[1])

    def collide_instance(self, inst: dict, label: str, pad: float = 0.0, *, door: str | None = None) -> None:
        """Colisor pela pegada real na altura do corpo (não pelo AABB do modelo, que inclui copa e toldo)."""
        b = self.instance_aabb(inst)
        pts = body_points(self.models[inst["m"]]["_src"], inst)
        boxes = footprint_boxes(pts, pad=pad)
        if not boxes:
            return
        for k, (x0, z0, x1, z1) in enumerate(boxes):
            self.collider(label if len(boxes) == 1 else f"{label}#{k}", x0, z0, x1, z1, max(b.maxY, 0.6), b.minY, door=door)

    def collider(self, label: str, x0: float, z0: float, x1: float, z1: float, top: float = 3.0, bottom: float = 0.0, *, door: str | None = None) -> None:
        d = Aabb(min(x0, x1), max(x0, x1), min(z0, z1), max(z0, z1), bottom, top).as_dict(label)
        if door:
            d["door"] = door       # folha de porta: o cliente desliga o colisor com a porta aberta
        self.colliders.append(d)

    # -- dados de jogo -----------------------------------------------------------
    def zone(self, key: str, x0: float, z0: float, x1: float, z1: float, title: str, sub: str, *, building: bool = False,
             priority: int = 1, clamp: bool = False, floor: float = 0.0, marco: str | None = None, interior_of: str | None = None,
             fog_boost: float = 0.0, ambient_tint: str | None = None) -> None:
        z = {"key": key, "minX": min(x0, x1), "maxX": max(x0, x1), "minZ": min(z0, z1), "maxZ": max(z0, z1),
             "name": title, "sub": sub, "building": building, "priority": priority, "cameraClamp": clamp, "floorY": floor}
        if marco:
            z["marco"] = marco
        if interior_of:
            z["interiorOf"] = interior_of
        if fog_boost:
            z["fogBoost"] = fog_boost
        if ambient_tint:
            z["ambientTint"] = ambient_tint
        self.zones.append(z)

    def roof(self, key: str, x0: float, z0: float, x1: float, z1: float) -> None:
        self.roofs.append({"key": key, "minX": min(x0, x1), "maxX": max(x0, x1), "minZ": min(z0, z1), "maxZ": max(z0, z1)})

    def light(self, key: str, x: float, y: float, z: float, color: str, intensity: float, distance: float, *, flicker: float = 0.05,
              zone: str | None = None, importance: float = 1.0, pool: float = 0.0, glow: float = 0.0) -> None:
        self.lights.append({"key": key, "p": [x, y, z], "color": color, "intensity": intensity, "distance": distance,
                            "decay": 2.0, "flicker": flicker, "zone": zone, "importance": importance, "pool": pool, "glow": glow})

    def anchor(self, key: str, x: float, y: float, z: float, **data) -> None:
        self.anchors[key] = {"p": [x, y, z], **data}

    def collectible(self, key: str, x: float, z: float, models: list[dict], reach: float = 1.4) -> None:
        """Objeto coletável: o servidor decide se ele ainda existe (quests.json -> coletaveis)."""
        self.collectibles[key] = {"p": [x, 0.0, z], "reach": reach}
        for spec in models:
            self.place(spec["kit"], spec["name"], spec.get("x", x), spec.get("y", 0.0), spec.get("z", z), spec.get("r", 0.0),
                       spec.get("s", 1.0), dyn=f"collect:{key}", tag=f"collect:{key}")

    def interactable(self, key: str, kind: str, x: float, z: float, label: str, reach: float = 2.2, **data) -> None:
        self.interactables.append({"key": key, "kind": kind, "p": [x, 0.0, z], "label": label, "reach": reach, **data})

    def node(self, key: str, x: float, z: float, look: tuple[float, float] | None = None, seat: float | None = None) -> str:
        if key in self.nodes:
            raise SystemExit(f"[ERRO] nó de navegação duplicado: {key}")
        n: dict = {"x": round(x, 3), "z": round(z, 3)}
        if look:
            n["look"] = {"x": look[0], "z": look[1]}
        if seat is not None:
            n["seatY"] = seat
        self.nodes[key] = n
        return key

    def link(self, *chain: str) -> None:
        for a, b in zip(chain, chain[1:]):
            self.edges.append((a, b))

    def street(self, x0: float, z0: float, x1: float, z1: float) -> None:
        self.cobble.append({"minX": min(x0, x1), "maxX": max(x0, x1), "minZ": min(z0, z1), "maxZ": max(z0, z1)})

    def flat_zone(self, x0: float, z0: float, x1: float, z1: float, blend: float = 12.0) -> None:
        self.flat_zones.append({"minX": min(x0, x1), "maxX": max(x0, x1), "minZ": min(z0, z1), "maxZ": max(z0, z1), "blend": blend})

    def dirt_road(self, x0: float, z0: float, x1: float, z1: float) -> None:
        self.dirt.append({"minX": min(x0, x1), "maxX": max(x0, x1), "minZ": min(z0, z1), "maxZ": max(z0, z1)})

    def water_patch(self, x0: float, z0: float, x1: float, z1: float, flow_x: float = 0.0, flow_z: float = 1.0) -> None:
        self.water.append({"minX": min(x0, x1), "maxX": max(x0, x1), "minZ": min(z0, z1), "maxZ": max(z0, z1),
                           "flow": [flow_x, flow_z], "flowX": flow_x, "flowZ": flow_z})

    # -- criaturas, fauna e partículas (lidos por enemies.js, fauna.js e world.js) -----------------
    def enemy_spawn(self, sid: str, tipo: str, x: float, z: float, yaw: float = 0.0,
                    patrulha: list[tuple[float, float]] | None = None, leash: float = 14.0) -> None:
        """Ponto de nascimento de um inimigo (tipo = chave de public/data/enemies.json). 'patrulha' é o laço que ele
        percorre em paz; sem ela, vagueia em volta do ponto. 'leash' é o raio além do qual ele desiste e volta."""
        if any(e["id"] == sid for e in self.enemy_spawns):
            raise SystemExit(f"[ERRO] spawn de inimigo duplicado: {sid}")
        self.enemy_spawns.append({"id": sid, "tipo": tipo, "x": round(x, 3), "z": round(z, 3), "yaw": round(yaw, 4),
                                  "patrulha": [[round(px, 3), round(pz, 3)] for px, pz in (patrulha or [])],
                                  "leash": leash})

    def respawn_point(self, key: str, x: float, z: float, yaw: float = 0.0) -> None:
        """Onde o jogador volta depois de uma derrota ('cidade' = enfermaria do Templo, 'acampamento' = fogueira)."""
        self.respawns[key] = {"x": round(x, 3), "z": round(z, 3), "yaw": round(yaw, 4)}

    def fauna(self, fid: str, especie: str, pontos: list[tuple[float, float]], *, altura: float = 1.0,
              velocidade: float = 1.2, fuga: float = 7.0, salto: bool = False) -> None:
        """Animal não hostil que circula pelo laço 'pontos' e foge do jogador a menos de 'fuga' metros.
        'especie' é a chave de runtimeModels (ex.: 'pets/animal-deer'); 'salto' troca o passo por pulinhos."""
        self.fauna_list.append({"id": fid, "modelo": especie, "altura": altura, "velocidade": velocidade, "fuga": fuga,
                                "salto": salto, "pontos": [[round(px, 3), round(pz, 3)] for px, pz in pontos]})

    def particle_field(self, key: str, kind: str, x0: float, z0: float, x1: float, z1: float, *, count: int, color: str,
                       y0: float = 0.3, y1: float = 3.0, size: float = 0.12, night: float = 0.5, speed: float = 0.3) -> None:
        """Nuvem de partículas ambientais (pool fixo de Points; o shader anima, o frame só troca uniforms).
        night: quanto a nuvem some de dia (0 = igual dia e noite, 1 = só à noite)."""
        self.particles.append({"key": key, "kind": kind, "minX": min(x0, x1), "maxX": max(x0, x1), "minZ": min(z0, z1),
                               "maxZ": max(z0, z1), "y0": y0, "y1": y1, "count": count, "color": color, "size": size,
                               "night": night, "speed": speed})

    # -- arquitetura Kenney modular -------------------------------------------------
    def kenney(self, name: str, x: float, y: float, z: float, r: float, *, pal: str, mirror: bool = False, sy: float = 1.0, tag: str = "") -> dict:
        s = [K, K * sy, -K if mirror else K] if (mirror or sy != 1.0) else K
        return self.place("kenney", name, x, y, z, r, s, pal=pal, tag=tag)

    def building(self, key: str, x0: float, z0: float, W: int, D: int, *, floors: int = 2, ridge: str = "x", pal: str = "creme_vermelho",
                 doors: list[tuple[float, float]] = (), interior: bool = False, style: str = "plaster", roof: str = "roof",
                 title: str = "", sub: str = "", front_zone: bool = True, chimney: tuple[int, int] | None = None,
                 blank_sides: str = "", window: str = "wall-window-glass", upper_window: str = "wall-window-small",
                 lit: float = 0.7, room: str = "casa", upper_room: str | None = None, door_open: bool | None = None,
                 mezzanine: bool = True, window_floors: tuple[int, ...] | None = None, plinth: str | None = None,
                 timber_pattern: str | None = None, dormers: int = 0, awning: bool = False) -> Building:
        """
        Prédio Kenney com W x D células (x, z) a partir do canto noroeste (x0, z0).
        ridge: eixo da cumeeira ('x' ou 'z'); a dimensão transversal precisa ser 1, 2 ou 4 células.
        doors: pontos (x, z) próximos a paredes externas no térreo; cada um vira um vão (porta aberta se interior=True).
        style: 'plaster' (reboco), 'timber' (enxaimel com mãos-francesas), 'wood' (tábuas) ou 'stone'.
        room/upper_room: tipo de cômodo que o shader de interior (interiors.js) finge atrás das janelas e
        da porta aberta de prédios sem interior real (térreo / andares de cima).
        mezzanine=False: interior de pé-direito alto (salão, nave), sem o assoalho do segundo andar.
        window_floors: andares (acima do térreo) que recebem upper_window; os outros ficam lisos (uma fileira de
        rosáceas a meia altura em vez de janela em todo andar: mais bonito e um terço dos triângulos).
        Variações (custo baixo em triângulos): plinth = paleta do térreo (embasamento de pedra sob o reboco);
        timber_pattern = módulo do enxaimel nos andares de cima ('wall-detail-cross' | '-diagonal' | '-horizontal');
        dormers = águas-furtadas por água na primeira fileira do telhado; awning = marquise sobre cada porta.
        """
        across = D if ridge == "x" else W
        if across not in (1, 2, 4):
            raise SystemExit(f"[ERRO] {key}: dimensão transversal à cumeeira deve ser 1, 2 ou 4 (é {across})")
        b = Building(key, x0, z0, W, D, floors, Aabb(x0, x0 + W * K, z0, z0 + D * K, 0.0, floors * K), interior)
        tagb = f"b:{key}"
        # Vãos de porta: célula de borda mais próxima de cada ponto
        door_cells: set[tuple[str, int]] = set()
        edges = self._perimeter(b)
        for dx, dz in doors:
            best = min(edges, key=lambda e: math.hypot(e[2] - dx, e[3] - dz))
            door_cells.add((best[0], best[1]))
            b.doors.append((best[0], best[2], best[3]))
        blank = set(blank_sides)
        lower = {"plaster": "wall", "timber": "wall", "wood": "wall-wood", "stone": "wall"}[style]
        upper_plain = {"plaster": "wall", "timber": "wall-detail-cross", "wood": "wall-wood", "stone": "wall"}[style]
        if style == "timber" and timber_pattern:
            upper_plain = timber_pattern
        for f in range(floors):
            y = f * K
            for idx, (side, n, cx, cz) in enumerate(edges):
                wx, wz = self._edge_wall_point(side, cx, cz)
                door_here = f == 0 and (side, n) in door_cells
                if door_here:
                    # Sempre o módulo com folha: o nó 'door' do GLB tem pivô na dobradiça e o cliente o anima
                    piece = "wall-door" if style != "wood" else "wall-wood-door"
                elif side in blank:
                    piece = lower if f == 0 else upper_plain
                else:
                    pattern = (n + f) % 3
                    if f == 0:
                        piece = window if pattern != 1 else lower
                    elif window_floors is not None and f not in window_floors:
                        piece = upper_plain
                    else:
                        piece = upper_window if pattern != 2 else upper_plain
                    if style == "wood" and piece.startswith("wall-window"):
                        piece = piece.replace("wall-", "wall-wood-", 1)
                inst = self.kenney(piece, wx, y, wz, SIDE_ROT[side], pal=plinth if (plinth and f == 0) else pal, tag=tagb)
                ox, oz = SIDE_VEC[side]
                if door_here and awning:
                    # A peça fica dentro da célula, junto à borda +X: vai na célula de fora, virada para a parede
                    self.kenney("overhang", wx + ox * K, 0.0, wz + oz * K, SIDE_ROT[side] + math.pi, pal=pal, tag=tagb)
                f_room = room if f == 0 else (upper_room or ("quarto" if room not in ("templo", "salao", "quartel", "armazem") else room))
                if door_here:
                    did = f"{key}:{side}{n}"
                    inst["door"] = did
                    is_open = bool(interior if door_open is None else door_open)
                    # Nó 'door' do Kenney: pivô na dobradiça, folha em +Z local; ângulo negativo abre para dentro (-X)
                    inst["hinge"] = {"key": did, "node": "door", "axis": "y", "angle": -1.75, "dur": 0.6, "open": is_open}
                    self.doors.append({"id": did, "b": key, "inst": len(self.instances) - 1,
                                       "p": [round(wx + ox * K * 0.5, 3), 0.0, round(wz + oz * K * 0.5, 3)], "r": SIDE_ROT[side],
                                       "w": round(0.4 * K, 3), "h": round(0.75 * K, 3), "enterable": interior, "room": room,
                                       "locked": not interior, "open": is_open,
                                       "col": f"Door_{did}" if interior else None})
                if "window" in piece:
                    # Quadro logo à frente do vidro (borda externa da célula), voltado para fora, do tamanho do vão real
                    hw, cy, hh = WINDOW_OPENINGS[piece]
                    seed = zlib.crc32(f"{key}:{idx}:{f}".encode())
                    self.windows.append({"id": f"w{len(self.windows)}", "b": key, "floor": f, "room": f_room, "real": interior,
                                         "p": [round(wx + ox * K * 0.505, 3), round(y + K * cy, 3), round(wz + oz * K * 0.505, 3)],
                                         "r": SIDE_ROT[side], "w": round(K * hw * 2, 3), "h": round(K * hh * 2, 3),
                                         "depth": round(K * (0.85 if across_of(b, side) > 1 else 0.6), 3), "seed": round((seed % 997) / 997.0, 4),
                                         "shutters": "shutters" in piece, "open": (seed >> 8) % 100 < 80,
                                         "lit": (seed % 100) < lit * 100})
        self._roof(b, ridge, pal, roof, tagb, dormers)
        if chimney:
            ci, cj = chimney
            cx, cz = x0 + (ci + 0.5) * K, z0 + (cj + 0.5) * K
            top = floors * K + (across / 2) * 0.5 * K + 0.5 * K
            self.kenney("chimney-base", cx, floors * K + 0.5 * K, cz, 0.0, pal=pal, sy=(top - floors * K) / K, tag=tagb)
            self.kenney("chimney-top", cx, top + 0.5 * K, cz, 0.0, pal=pal, tag=tagb)
        # Telhado (chuva), colisão e zonas
        self.roof(key, b.box.minX - 0.6, b.box.minZ - 0.6, b.box.maxX + 0.6, b.box.maxZ + 0.6)
        if interior:
            self._wall_colliders(b, door_cells, edges)
            for i in range(W):
                for j in range(D):
                    cx, cz = x0 + (i + 0.5) * K, z0 + (j + 0.5) * K
                    self.place("kenney", "planks", cx, 0.0, cz, 0.0, K, pal=pal, tag=tagb, cast=False)
                    if floors > 1 and mezzanine:
                        self.place("kenney", "planks", cx, K - 0.17, cz, 0.0, K, pal=pal, tag=tagb, cast=False)
            if title:
                self.zone(key, b.box.minX + 0.15, b.box.minZ + 0.15, b.box.maxX - 0.15, b.box.maxZ - 0.15, title, sub,
                          building=True, priority=3, clamp=True, floor=0.02, interior_of=key)
        else:
            self.collider(f"Col_{key}", b.box.minX - 0.05, b.box.minZ - 0.05, b.box.maxX + 0.05, b.box.maxZ + 0.05)
        if title and front_zone and b.doors:
            side, dx, dz = b.doors[0]
            ox, oz = SIDE_VEC[side]
            px, pz = -oz, ox
            self.zone(f"{key}_Frente", dx - px * 3.5, dz - pz * 3.5, dx + px * 3.5 + ox * 4.0, dz + pz * 3.5 + oz * 4.0,
                      title, sub, priority=2)
        self.buildings[key] = b
        return b

    def _perimeter(self, b: Building) -> list[tuple[str, int, float, float]]:
        """Arestas externas: (lado, índice, cx, cz) com o centro da célula de borda."""
        out = []
        for i in range(b.W):
            cx = b.x0 + (i + 0.5) * K
            out.append(("N", i, cx, b.z0 + 0.5 * K))
            out.append(("S", i, cx, b.z0 + (b.D - 0.5) * K))
        for j in range(b.D):
            cz = b.z0 + (j + 0.5) * K
            out.append(("W", j, b.x0 + 0.5 * K, cz))
            out.append(("E", j, b.x0 + (b.W - 0.5) * K, cz))
        return out

    @staticmethod
    def _edge_wall_point(side: str, cx: float, cz: float) -> tuple[float, float]:
        # O módulo é posicionado no centro da célula; a parede cai na borda pelo próprio offset do GLB.
        return cx, cz

    def _wall_colliders(self, b: Building, door_cells: set, edges: list) -> None:
        h = WALL_T * 0.5
        for side, n, cx, cz in edges:
            ox, oz = SIDE_VEC[side]
            wx, wz = cx + ox * (K * 0.5 - h), cz + oz * (K * 0.5 - h)
            if side in ("N", "S"):
                segs = [(cx - K * 0.5, cx + K * 0.5)]
                if (side, n) in door_cells:
                    segs = [(cx - K * 0.5, cx - 0.72), (cx + 0.72, cx + K * 0.5)]
                    self.collider(f"Door_{b.key}:{side}{n}", cx - 0.72, wz - h, cx + 0.72, wz + h, door=f"{b.key}:{side}{n}")
                for a, c in segs:
                    self.collider(f"Col_{b.key}_{side}{n}", a, wz - h, c, wz + h)
            else:
                segs = [(cz - K * 0.5, cz + K * 0.5)]
                if (side, n) in door_cells:
                    segs = [(cz - K * 0.5, cz - 0.72), (cz + 0.72, cz + K * 0.5)]
                    self.collider(f"Door_{b.key}:{side}{n}", wx - h, cz - 0.72, wx + h, cz + 0.72, door=f"{b.key}:{side}{n}")
                for a, c in segs:
                    self.collider(f"Col_{b.key}_{side}{n}", wx - h, a, wx + h, c)

    def _roof(self, b: Building, ridge: str, pal: str, roof: str, tag: str, dormers: int = 0) -> None:
        """Sótão (meia-parede nas faces longas, empenas em degrau) e águas do telhado (com águas-furtadas opcionais
        na fileira do beiral, espalhadas entre as peças internas)."""
        base = b.floors * K
        # Moldura local: u ao longo da cumeeira, v transversal; mapeia para o mundo
        if ridge == "x":
            nu, nv = b.W, b.D
            to_world = lambda u, v: (b.x0 + u, b.z0 + v)  # noqa: E731
            phi = 0.0
        else:
            nu, nv = b.D, b.W
            # u ao longo de +z, v ao longo de -x (rotação de -90°): local +u -> mundo +z
            to_world = lambda u, v: (b.x0 + b.W * K - v, b.z0 + u)  # noqa: E731
            phi = -math.pi / 2
        high = roof == "high"
        if high and nv != 1:
            raise SystemExit(f"[ERRO] {b.key}: telhado alto só em prédios de 1 célula transversal (empenas em degrau não fecham com 'roof-high')")
        rise = 0.5
        slope = "roof-high" if high else "roof"
        if nv == 1:
            for i in range(nu):
                x, z = to_world((i + 0.5) * K, 0.5 * K)
                name = ("roof-high-gable" if high else "roof-gable") if 0 < i < nu - 1 else ("roof-high-gable-end" if high else "roof-gable-end")
                # gable: cumeeira no X local; gable-end: ponta em quatro águas descendo para o -X local
                rot = phi + (0.0 if i == 0 else math.pi) if name.endswith("end") else phi
                self.kenney(name, x, base, z, rot, pal=pal, tag=tag)
            return
        half = nv // 2
        dormer_at = {round((d + 1) * (nu - 1) / (dormers + 1)) for d in range(dormers)} if nu > 2 else set()
        # Meia-parede do sótão nas faces longas (v = 0 e v = nv)
        for i in range(nu):
            for v_edge, side_rot in ((0.5, math.pi / 2), (nv - 0.5, -math.pi / 2)):
                x, z = to_world((i + 0.5) * K, v_edge * K)
                self.kenney("wall-half", x, base, z, phi + side_rot, pal=pal, tag=tag)
        for j in range(nv):
            k = j if j < half else nv - 1 - j          # fileira contada a partir do beiral
            north = j < half                            # metade de v menor: sobe para +v
            y = base + 0.5 * K + k * rise * K
            for i in range(nu):
                x, z = to_world((i + 0.5) * K, (j + 0.5) * K)
                if i == 0:
                    piece = f"{slope}-right" if north else f"{slope}-left"
                elif i == nu - 1:
                    piece = f"{slope}-left" if north else f"{slope}-right"
                else:
                    piece = "roof-window" if (k == 0 and not high and i in dormer_at) else slope
                # 'roof' sobe para o +X local: norte -> +v (rot -90°), sul -> -v (rot +90°)
                self.kenney(piece, x, y, z, phi + (-math.pi / 2 if north else math.pi / 2), pal=pal, tag=tag)
            # Empenas nas pontas (u = 0 e u = nu): enchimento + wall-slope com o lado alto para a cumeeira
            for i_end, end_rot in ((0, math.pi), (nu - 1, 0.0)):
                x, z = to_world((i_end + 0.5) * K, (j + 0.5) * K)
                for f in range(int(round(k * rise * 2))):
                    self.kenney("wall-half", x, base + f * 0.5 * K, z, phi + end_rot, pal=pal, tag=tag)
                # wall-slope: lado alto em +Z local. Ponta leste (rot 0): alto em +v -> norte normal, sul espelhado.
                mirror = (not north) if end_rot == 0.0 else north
                self.kenney("wall-slope", x, base + k * rise * K, z, phi + end_rot, pal=pal, mirror=mirror, tag=tag)

    # -- conjuntos prontos ----------------------------------------------------------
    def tower(self, key: str, x0: float, z0: float, floors: int, *, pal: str, window: str = "wall-window-small",
              roof: str = "roof-high-point", solid: bool = True, spire: float = 1.0, y0: float = 0.0) -> None:
        """Torre de 1 célula (campanário, guarita, torre da muralha) com coruchéu piramidal.
        spire: altura do coruchéu em células (1 = o do kit); y0: base elevada (torre sobre um telhado)."""
        cx, cz = x0 + 0.5 * K, z0 + 0.5 * K
        tag = f"b:{key}"
        for f in range(floors):
            for side in ("N", "S", "E", "W"):
                piece = window if (f % 2 == 1 or f == floors - 1) else "wall"
                self.kenney(piece, cx, y0 + f * K, cz, SIDE_ROT[side], pal=pal, tag=tag)
        self.kenney(roof, cx, y0 + floors * K, cz, 0.0, pal=pal, sy=spire, tag=tag)
        self.roof(key, x0 - 0.4, z0 - 0.4, x0 + K + 0.4, z0 + K + 0.4)
        if solid and y0 == 0.0:
            self.collider(f"Col_{key}", x0 - 0.05, z0 - 0.05, x0 + K + 0.05, z0 + K + 0.05)

    def big_tower(self, key: str, x0: float, z0: float, *, cells: int = 2, floors: int = 4, pal: str = "pedra",
                  window: str = "wall-window-small", roof: str = "roof-high-point", spire: float = 1.6,
                  base_pal: str | None = None, base_floors: int = 0, window_every: int = 0, y0: float = 0.0) -> None:
        """Torre larga (cells x cells) para castelo e portões: paredes modulares e coruchéu ampliado.

        spire: altura do coruchéu em células; base_pal/base_floors: embasamento noutra paleta (pedra até a
        altura da muralha, corpo branco acima); window_every: seteira a cada N andares (além do último);
        y0: base elevada (torre de cruzeiro sobre um telhado: sem colisor)."""
        tag = f"b:{key}"
        b = Building(key, x0, z0, cells, cells, floors, Aabb(x0, x0 + cells * K, z0, z0 + cells * K), False)
        for f in range(floors):
            f_pal = base_pal if base_pal and f < base_floors else pal
            for side, n, cx, cz in self._perimeter(b):
                # Seteira por face só nos andares escolhidos (janela custa ~3-5x a parede lisa em triângulos)
                slit = f == floors - 1 or (window_every and f >= base_floors and (floors - 1 - f) % window_every == 0)
                piece = window if slit and n == cells // 2 else "wall"
                self.kenney(piece, cx, y0 + f * K, cz, SIDE_ROT[side], pal=f_pal, tag=tag)
        cx, cz = x0 + cells * K * 0.5, z0 + cells * K * 0.5
        self.place("kenney", roof, cx, y0 + floors * K, cz, 0.0, [K * cells * 0.98, K * spire, K * cells * 0.98], pal=pal, tag=tag)
        self.roof(key, x0 - 0.4, z0 - 0.4, x0 + cells * K + 0.4, z0 + cells * K + 0.4)
        if y0 == 0.0:
            self.collider(f"Col_{key}", x0 - 0.05, z0 - 0.05, x0 + cells * K + 0.05, z0 + cells * K + 0.05, floors * K)
        self.buildings[key] = b

    def wall_run(self, key: str, x0: float, z0: float, x1: float, z1: float, *, height: float = 1.2, thick: float = 1.1,
                 tag: str = "city_wall", model: str = "wall") -> None:
        """Muralha reta de (x0, z0) a (x1, z1) com módulos KayKit esticados para fechar o vão exato (sem frestas)."""
        length = math.hypot(x1 - x0, z1 - z0)
        if length < 0.5:
            return
        n = max(1, math.ceil(length / 11.0 - 1e-6))   # módulo esticado até ~11 m: metade dos triângulos de 8 m
        sx = length / n / 4.0                     # o módulo 'wall' tem 4 unidades de comprimento em X
        rot = -math.atan2(z1 - z0, x1 - x0)       # X local ao longo do trecho (rot_y(1, 0, r) = (cos r, -sin r))
        for k in range(n):
            t = (k + 0.5) / n
            inst = self.place("dungeon", model, x0 + (x1 - x0) * t, 0.0, z0 + (z1 - z0) * t, rot, [sx, height, thick], tag=tag)
            self.collide_instance(inst, f"Col_{key}_{k}")

    def gate(self, key: str, x: float, z: float, rot: float, *, sx: float = 1.75, sy: float = 1.15, sz: float = 1.1,
             open_: bool = False, angle: float = -1.65, tag: str = "city_wall") -> dict:
        """Portão com folha articulada (KayKit 'wall_doorway', nó 'wall_doorway_door' com pivô na borda).

        Batentes sempre sólidos; o vão só bloqueia com o portão fechado (colisor com 'gate').
        """
        inst = self.place("dungeon", "wall_doorway", x, 0.0, z, rot, [sx, sy, sz], tag=tag,
                          hinge={"key": key, "node": "wall_doorway_door", "axis": "y", "angle": angle, "dur": 2.4, "open": open_})
        self.gates.append({"key": key, "hinge": key, "open": open_})
        half_open, half_all, th = 1.0 * sx, 2.0 * sx, 0.5 * sz
        for k, (a, b) in enumerate(((-half_all, -half_open), (half_open, half_all))):
            pts = [rot_y(a, -th, rot), rot_y(b, th, rot)]
            self.collider(f"Col_{key}_batente{k}", x + min(p[0] for p in pts), z + min(p[1] for p in pts),
                          x + max(p[0] for p in pts), z + max(p[1] for p in pts), 4.0 * sy)
        pts = [rot_y(-half_open, -th, rot), rot_y(half_open, th, rot)]
        d = Aabb(x + min(p[0] for p in pts), x + max(p[0] for p in pts), z + min(p[1] for p in pts), z + max(p[1] for p in pts), 0.0, 4.0 * sy).as_dict(f"Gate_{key}")
        d["gate"] = key
        self.colliders.append(d)
        return inst

    def lamp(self, key: str, x: float, z: float, *, pal: str = "creme_vermelho") -> None:
        self.place("kenney", "lantern", x, 0.0, z, 0.0, 2.0, pal=pal, tag="lamp", collide=f"Col_Lamp_{key}", pad=0.05)
        self.light(f"Lamp_{key}", x, 2.85, z, "#ffb15c", 10.0, 13.0, flicker=0.04, importance=0.8, pool=4.8, glow=1.5)

    def tree(self, name: str, x: float, z: float, s: float = 1.0, r: float = 0.0, kit: str = "forest", collide: bool = True) -> None:
        inst = self.place(kit, name, x, 0.0, z, r, s, tag="tree")
        if collide:
            # Só o tronco (faixa do corpo); a copa fica acima e não pode virar parede invisível
            self.collide_instance(inst, f"Col_Tree_{len(self.colliders)}")
        return inst

    # -- saída -------------------------------------------------------------------------
    def validate(self, npcs: dict, quests: dict) -> list[str]:
        problems = []
        for a, b in self.edges:
            for k in (a, b):
                if k not in self.nodes:
                    problems.append(f"aresta usa nó inexistente: {k}")
        for npc_id, npc in npcs["npcs"].items():
            for step in npc.get("rotina", []):
                if step["to"] not in self.nodes:
                    problems.append(f"rotina de {npc_id} usa nó inexistente: {step['to']}")
            if npc.get("casa") not in self.nodes:
                problems.append(f"casa de {npc_id} inexistente: {npc.get('casa')}")
        for rota in npcs["figurantes"]["rotas"]:
            for p in rota["pontos"]:
                if p not in self.nodes:
                    problems.append(f"rota de figurante usa nó inexistente: {p}")
        chest_loots = {it.get("loot") for it in self.interactables if it.get("loot")}
        for key in quests["coletaveis"]:
            if key not in self.collectibles and key not in chest_loots:
                problems.append(f"coletável sem posição no mapa: {key}")
        enemy_types = json.loads(ENEMIES_JSON.read_text(encoding="utf-8"))["inimigos"] if ENEMIES_JSON.is_file() else {}
        for e in self.enemy_spawns:
            if e["tipo"] not in enemy_types:
                problems.append(f"spawn {e['id']} usa tipo de inimigo inexistente: {e['tipo']}")
        runtime = {f"{kit}/{name}" for kit, name in RUNTIME_MODELS}
        for f in self.fauna_list:
            if f["modelo"] not in runtime:
                problems.append(f"fauna {f['id']} usa modelo fora de RUNTIME_MODELS: {f['modelo']}")
        for key in ("cidade", "acampamento"):
            if key not in self.respawns:
                problems.append(f"ponto de renascimento ausente: {key}")
        marcos = {z.get("marco") for z in self.zones if z.get("marco")}
        for qid, q in quests["missoes"].items():
            for et in q["etapas"]:
                for m in et["objetivo"].get("marcos", []):
                    if m not in marcos:
                        problems.append(f"missão {qid}: marco sem zona: {m}")
        return problems

    def _write_palettes(self) -> None:
        from PIL import Image
        base = Image.open(KITS["kenney"]["dir"] / "Textures" / "colormap.png").convert("RGBA")
        out_dir = KITS_OUT / "kenney" / "Textures"
        out_dir.mkdir(parents=True, exist_ok=True)
        for name, colors in PALETTES.items():
            wall, roof = colors[0], colors[1]
            img = base.copy()
            _recolor(img, SWATCH_WALL, wall)
            _recolor(img, SWATCH_ROOF, roof)
            # Terceira cor opcional: vigas viram cantaria nas paletas de pedra (torres, castelo)
            _recolor(img, SWATCH_TIMBER, colors[2] if len(colors) > 2 else TIMBER_COLOR)
            _recolor(img, SWATCH_ROOF_HIGH, roof)
            _write_surface_classes(img, name)
            img.save(out_dir / f"pal_{name}.png", optimize=True)
        img = base.copy()
        _write_surface_classes(img, "base")
        img.save(out_dir / "pal_base.png", optimize=True)

    @staticmethod
    def _copy_model(src: Path, kit: str) -> None:
        """Copia o modelo para public/assets/kits/<kit>/ com os .bin e as texturas que o glTF referencia."""
        dst = KITS_OUT / kit / src.name
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        if src.suffix == ".gltf":
            g = json.loads(src.read_text(encoding="utf-8"))
            for buf in g.get("buffers", []):
                if "uri" in buf and not buf["uri"].startswith("data:"):
                    shutil.copy2(src.parent / buf["uri"], dst.parent / buf["uri"])
            for img in g.get("images", []):
                if "uri" in img and not img["uri"].startswith("data:"):
                    (dst.parent / img["uri"]).parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(src.parent / img["uri"], dst.parent / img["uri"])

    def _export_runtime_models(self, used_kits: set[str]) -> dict[str, str]:
        """Copia RUNTIME_MODELS (sem instância na cidade) e devolve {"kit/nome": url} para o cliente."""
        out: dict[str, str] = {}
        for kit, name in RUNTIME_MODELS:
            spec = KITS[kit]
            src = spec["dir"] / f"{name}{spec['ext']}"
            if not src.is_file():
                raise SystemExit(f"[ERRO] modelo de runtime inexistente: {src}")
            self._copy_model(src, kit)
            used_kits.add(kit)
            out[f"{kit}/{name}"] = f"./assets/kits/{kit}/{name}{spec['ext']}"
        return out

    def export(self) -> dict:
        KITS_OUT.mkdir(parents=True, exist_ok=True)
        used_kits: set[str] = set()
        for key, m in self.models.items():
            src = Path(m.pop("_src"))
            kit = m["kit"]
            used_kits.add(kit)
            self._copy_model(src, kit)
        runtime_models = self._export_runtime_models(used_kits)
        for kit in used_kits:
            for extra in KITS[kit]["extra"]:
                s = KITS[kit]["dir"] / extra
                d = KITS_OUT / kit / extra
                d.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(s, d)
            lic = next((p for p in (KITS[kit]["dir"] / "License.txt", KITS[kit]["dir"] / "LICENSE.txt", KITS[kit]["dir"].parent / "LICENSE.txt") if p.is_file()), None)
            if lic:
                shutil.copy2(lic, KITS_OUT / kit / "LICENSE.txt")
        self._write_palettes()
        _write_atlas_classes()
        chars = KITS_OUT / "chars"
        chars.mkdir(parents=True, exist_ok=True)
        for name in CHARACTER_MODELS:
            shutil.copy2(SRC / "kaykit_adventurers" / f"{name}.glb", chars / f"{name}.glb")
        shutil.copy2(SRC / "kaykit_adventurers" / "LICENSE.txt", chars / "LICENSE.txt")
        tris = sum(self.models[i["m"]]["tris"] for i in self.instances)
        instanced_tris = sum(
            self.models[i["m"]]["tris"]
            for i in self.instances
            if not i.get("dyn") and not i.get("hinge")
            and (self.models[i["m"]]["kit"] == "forest" or i.get("tag") in ("forest", "tree", "bush", "rock"))
        )
        static_tris = tris - instanced_tris
        return {
            "versao": 1,
            "cell": K,
            "bounds": self.bounds,
            "walk": self.walk,
            "spawn": self.spawn,
            "models": self.models,
            "instances": self.instances,
            "colliders": self.colliders,
            "zones": self.zones,
            "roofs": self.roofs,
            "lights": self.lights,
            "glows": self.glows,
            "windows": self.windows,
            "doors": self.doors,
            "gates": self.gates,
            "terrain": self.terrain | {"hill": TERRAIN_HILL},
            "flatZones": self.flat_zones,
            "runtimeModels": runtime_models,
            "enemySpawns": self.enemy_spawns,
            "respawns": self.respawns,
            "fauna": self.fauna_list,
            "particles": self.particles,
            "anchors": self.anchors,
            "collectibles": self.collectibles,
            "interactables": self.interactables,
            "nav": {"nodes": self.nodes, "edges": [list(e) for e in self.edges]},
            "ground": {"cobble": self.cobble, "dirt": self.dirt, "water": self.water},
            "palettes": {name: f"./assets/kits/kenney/Textures/pal_{name}.png" for name in PALETTES} | {"base": "./assets/kits/kenney/Textures/pal_base.png"},
            "stats": {"instances": len(self.instances), "models": len(self.models), "triangles": tris,
                      "static_triangles": static_tris, "instanced_triangles": instanced_tris,
                      "colliders": len(self.colliders), "lights": len(self.lights)},
        }


def across_of(b: Building, side: str) -> int:
    """Profundidade (em células) do prédio a partir da parede 'side'."""
    return b.W if side in ("E", "W") else b.D


def _write_atlas_classes() -> None:
    """Classe de superfície no alfa dos atlas dos kits KayKit (regiões em detail.json -> 'atlas'), mesma
    codificação das paletas Kenney: o shader de detalhe vale também para muralha, pilares e móveis."""
    from PIL import Image
    spec = json.loads(DETAIL_SPEC.read_text(encoding="utf-8"))
    ids = [c["id"] for c in spec["camadas"]]
    for kit, atlas in spec.get("atlas", {}).items():
        src = KITS[kit]["dir"] / atlas["arquivo"]
        img = Image.open(src).convert("RGBA")
        alpha = img.getchannel("A").point(lambda _v: 255)
        for reg in atlas["regioes"]:
            alpha.paste(255 - 32 * (ids.index(reg["camada"]) + 1), tuple(reg["rect"]))
        img.putalpha(alpha)
        img.save(KITS_OUT / kit / atlas["arquivo"], optimize=True)


def _write_surface_classes(img, palette: str) -> None:
    """Classe de superfície no alfa de cada célula (32 x 128 px) do atlas: 255 = sem detalhe, 255 - 32 k =
    camada k de public/textures/detail.json (índice + 1). 'paletas' sobrepõe 'celulas' (reboco vira pedra
    nas paletas de pedra). O shader do navegador lê a mesma regra (materials.js, enableSurfaceDetail)."""
    spec = json.loads(DETAIL_SPEC.read_text(encoding="utf-8"))
    ids = [c["id"] for c in spec["camadas"]]
    cells = dict(spec["celulas"]) | spec["paletas"].get(palette, {})
    alpha = img.getchannel("A").point(lambda _v: 255)
    for key, layer in cells.items():
        col, row = (int(v) for v in key.split(","))
        alpha.paste(255 - 32 * (ids.index(layer) + 1), (col * 32, row * 128, col * 32 + 32, row * 128 + 128))
    img.putalpha(alpha)


def _recolor(img, box: tuple[int, int, int, int], hex_color: str) -> None:
    """Troca a cor de uma célula do atlas mantendo o degradê (sombra embutida) da original."""
    from PIL import Image  # noqa: F401
    region = img.crop(box)
    px = region.load()
    w, h = region.size
    lum = [[0.0] * h for _ in range(w)]
    total = 0.0
    for x in range(w):
        for y in range(h):
            r, g, b = px[x, y][:3]
            lum[x][y] = 0.299 * r + 0.587 * g + 0.114 * b
            total += lum[x][y]
    mean = max(1.0, total / (w * h))
    tr, tg, tb = (int(hex_color[i:i + 2], 16) for i in (1, 3, 5))
    for x in range(w):
        for y in range(h):
            k = lum[x][y] / mean
            a = px[x, y][3] if len(px[x, y]) > 3 else 255
            px[x, y] = (min(255, int(tr * k)), min(255, int(tg * k)), min(255, int(tb * k)), a)
    img.paste(region, box[:2])


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass
    spec = importlib.util.spec_from_file_location("city_layout", ROOT / "tools" / "city_layout.py")
    layout = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(layout)
    city = City()
    layout.build(city)
    npcs = json.loads((ROOT / "public" / "data" / "npcs.json").read_text(encoding="utf-8"))
    quests = json.loads((ROOT / "public" / "data" / "quests.json").read_text(encoding="utf-8"))
    problems = city.validate(npcs, quests)
    if problems:
        for p in problems:
            print(f"[ERRO] {p}")
        return 1
    data = city.export()
    if data["stats"]["triangles"] > TRIANGLE_BUDGET:
        print(f"[ERRO] orçamento de triângulos estourado: {data['stats']['triangles']} > {TRIANGLE_BUDGET}")
        return 1
    CITY_OUT.parent.mkdir(parents=True, exist_ok=True)
    CITY_OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    st = data["stats"]
    print(f"[OK] {CITY_OUT.relative_to(ROOT)}: {st['instances']} instâncias, {st['models']} modelos, {st['triangles']} triângulos, "
          f"{st['colliders']} colisores, {st['lights']} luzes, {len(data['nav']['nodes'])} nós de navegação")
    return 0


if __name__ == "__main__":
    sys.exit(main())
