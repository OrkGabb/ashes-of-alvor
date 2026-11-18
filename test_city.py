#!/usr/bin/env python3
"""
Validação da cidade pelo dado que o jogo realmente carrega (public/assets/city/city.json):

1. Rotas de NPC: toda aresta do grafo de navegação passa a >= raio do NPC de qualquer colisor.
2. Alcance a pé: uma busca em grade (célula de 0,2 m, raio real do jogador) parte do spawn e precisa
   chegar ao alcance de conversa de cada nó de rotina dos NPCs, de cada coletável e do quadro da
   Guilda — incluindo o salão da estalagem (porta da frente) e o pátio (porta dos fundos).
   Controle negativo: o mesmo mapa com a porta da frente da estalagem bloqueada precisa tornar o
   balcão inalcançável (prova que a busca enxerga paredes e portas de verdade).
3. Integridade: todo modelo referenciado existe em disco; nenhum nó/rotina aponta para lugar inexistente;
   orçamento de triângulos respeitado.
6. Relevo: a altura do terreno exatamente como a GPU desenha (vértices da malha de terrain.hill.cell metros,
   interpolação linear no triângulo do PlaneGeometry) em toda célula alcançável fica <= 0,35 m: ninguém anda
   "dentro" do morro. Controle negativo: sem o sopé de rochas (Col_Sope_*) a mesma medição tem de falhar.
7. Criaturas: todo spawn de inimigo, ponto e trecho de patrulha, laço de fauna e ponto de renascimento cai em
   célula alcançável; nenhum inimigo hostil nasce dentro da muralha; todos longe de coletáveis e postos de NPC.
   Controle negativo: um spawn plantado na Praça e outro atrás do sopé têm de ser apontados.

Execução:
  python test_city.py
"""
from __future__ import annotations

import json
import math
import sys
from collections import deque
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent
CITY = ROOT / "public" / "assets" / "city" / "city.json"
NPCS = ROOT / "public" / "data" / "npcs.json"
PLAYER_RADIUS = 0.32
NPC_RADIUS = 0.3
TALK_REACH = 3.4
CELL = 0.2
TRIANGLE_BUDGET = 850_000   # cidade + regiões extramuros ao sul (floresta e vegetação instanciadas)
ENEMIES = ROOT / "public" / "data" / "enemies.json"
TERRAIN_MAX_REACHABLE = 0.35   # m de relevo sob uma célula andável (o jogador anda em y = 0 e não sobe morro)
CREATURE_CLEAR = 8.0           # distância mínima de inimigo hostil para coletáveis e postos de NPC


def body_colliders(city: dict, closed: set[str] | None = None) -> list[dict]:
    """Colisores na altura do corpo no estado inicial do jogo: folha de porta só conta com a porta fechada."""
    closed = closed or set()
    open_doors = {d["id"] for d in city.get("doors", []) if d["open"]} - closed
    open_gates = {g["key"] for g in city.get("gates", []) if g["open"]} - closed
    return [c for c in city["colliders"] if not (c["minY"] > 1.4 or c["maxY"] < 0.25)
            and c.get("door") not in open_doors and c.get("gate") not in open_gates]


def dist_to_boxes(px: np.ndarray, pz: np.ndarray, cols: list[dict]) -> np.ndarray:
    lo = np.array([[c["minX"], c["minZ"]] for c in cols])
    hi = np.array([[c["maxX"], c["maxZ"]] for c in cols])
    qx = np.clip(px[:, None], lo[None, :, 0], hi[None, :, 0])
    qz = np.clip(pz[:, None], lo[None, :, 1], hi[None, :, 1])
    return np.hypot(px[:, None] - qx, pz[:, None] - qz).min(axis=1)


class Grid:
    def __init__(self, city: dict, cols: list[dict]) -> None:
        w = city["walk"]
        self.x0, self.z0 = w["minX"], w["minZ"]
        self.nx = int((w["maxX"] - w["minX"]) / CELL) + 1
        self.nz = int((w["maxZ"] - w["minZ"]) / CELL) + 1
        free = np.ones((self.nx, self.nz), dtype=bool)
        xs = self.x0 + np.arange(self.nx) * CELL
        zs = self.z0 + np.arange(self.nz) * CELL
        for c in cols:
            # Círculo do jogador x AABB: bloqueia células cujo centro fica a menos de r da caixa
            i0, i1 = np.searchsorted(xs, c["minX"] - PLAYER_RADIUS), np.searchsorted(xs, c["maxX"] + PLAYER_RADIUS)
            j0, j1 = np.searchsorted(zs, c["minZ"] - PLAYER_RADIUS), np.searchsorted(zs, c["maxZ"] + PLAYER_RADIUS)
            if i0 >= i1 or j0 >= j1:
                continue
            sx = xs[i0:i1][:, None]
            sz = zs[j0:j1][None, :]
            dx = np.maximum(0, np.maximum(c["minX"] - sx, sx - c["maxX"]))
            dz = np.maximum(0, np.maximum(c["minZ"] - sz, sz - c["maxZ"]))
            free[i0:i1, j0:j1] &= (dx * dx + dz * dz) >= PLAYER_RADIUS * PLAYER_RADIUS
        self.free = free
        self.xs, self.zs = xs, zs

    def cell(self, x: float, z: float) -> tuple[int, int]:
        return int(round((x - self.x0) / CELL)), int(round((z - self.z0) / CELL))

    def flood(self, x: float, z: float) -> np.ndarray:
        seen = np.zeros_like(self.free)
        i, j = self.cell(x, z)
        if not self.free[i, j]:
            raise AssertionError(f"spawn ({x}, {z}) está dentro de um colisor")
        q = deque([(i, j)])
        seen[i, j] = True
        while q:
            a, b = q.popleft()
            for da, db in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                na, nb = a + da, b + db
                if 0 <= na < self.nx and 0 <= nb < self.nz and self.free[na, nb] and not seen[na, nb]:
                    seen[na, nb] = True
                    q.append((na, nb))
        return seen

    def reach(self, seen: np.ndarray, x: float, z: float) -> float:
        """Distância do ponto até a célula alcançável mais próxima."""
        i, j = self.cell(x, z)
        r = int(TALK_REACH / CELL) + 2
        sub = seen[max(0, i - r): i + r + 1, max(0, j - r): j + r + 1]
        if not sub.any():
            return float("inf")
        ii, jj = np.nonzero(sub)
        px = self.xs[max(0, i - r) + ii]
        pz = self.zs[max(0, j - r) + jj]
        return float(np.hypot(px - x, pz - z).min())


PASSABLE_TAGS = ("bush", "collect:", "forest", "seat", "passable")   # 'seat': cadeiras e banquetas onde NPCs e jogador se sentam


def geometry_mask(city: dict, grid: "Grid") -> dict[str, np.ndarray]:
    """Ocupação real da geometria na faixa do corpo, rasterizada na grade do teste.

    'any': qualquer coisa visível (basta para justificar um colisor);
    'block': só o que deveria barrar (arbustos, coletáveis e mato ficam de fora).
    """
    sys.path.insert(0, str(ROOT / "tools"))
    from footprint import body_points  # noqa: E402
    any_m = np.zeros((grid.nx, grid.nz), dtype=bool)
    block = np.zeros_like(any_m)
    for inst in city["instances"]:
        x, z = inst["p"][0], inst["p"][2]
        if not (grid.x0 - 6 <= x <= grid.x0 + grid.nx * CELL + 6 and grid.z0 - 6 <= z <= grid.z0 + grid.nz * CELL + 6):
            continue
        url = city["models"][inst["m"]]["url"]
        pts = body_points(ROOT / "public" / url.lstrip("./"), inst)
        if not len(pts):
            continue
        i = np.round((pts[:, 0] - grid.x0) / CELL).astype(int)
        j = np.round((pts[:, 2] - grid.z0) / CELL).astype(int)
        ok = (i >= 0) & (i < grid.nx) & (j >= 0) & (j < grid.nz)
        any_m[i[ok], j[ok]] = True
        tag = inst.get("tag", "")
        # Peças articuladas (porta, portão) ficam de fora: a folha se move e o batente tem colisor próprio
        if not inst.get("dyn") and not tag.startswith(PASSABLE_TAGS) and not inst.get("hinge"):
            block[i[ok], j[ok]] = True
    return {"any": any_m, "block": block}


def _dilate(m: np.ndarray, r: int) -> np.ndarray:
    """Dilatação por disco de raio r células (com borda: sem dar a volta no outro lado da grade)."""
    nx, nz = m.shape
    pad = np.zeros((nx + 2 * r, nz + 2 * r), dtype=bool)
    pad[r:r + nx, r:r + nz] = m
    out = np.zeros_like(m)
    for di in range(-r, r + 1):
        for dj in range(-r, r + 1):
            if di * di + dj * dj <= r * r:
                out |= pad[r + di:r + di + nx, r + dj:r + dj + nz]
    return out


def invisible_walls(grid: "Grid", seen: np.ndarray, solid: dict, cols: list[dict]) -> list[str]:
    """Colisores cuja borda andável fica a mais de 0,3 m de qualquer geometria visível.

    Só conta a parte do colisor que o jogador consegue tocar (célula andável a até raio+1 célula):
    o miolo de uma casa fechada é oco por dentro, mas ninguém chega lá.
    """
    near_geo = _dilate(solid["any"], int(round(0.3 / CELL)))
    touch = _dilate(seen, int(round(PLAYER_RADIUS / CELL)) + 1)
    out = []
    for c in cols:
        if c.get("door"):
            continue
        i0, i1 = np.searchsorted(grid.xs, c["minX"]), np.searchsorted(grid.xs, c["maxX"], side="right")
        j0, j1 = np.searchsorted(grid.zs, c["minZ"]), np.searchsorted(grid.zs, c["maxZ"], side="right")
        if i0 >= i1 or j0 >= j1:
            continue
        t = touch[i0:i1, j0:j1]
        bad = t & ~near_geo[i0:i1, j0:j1]
        area = float(bad.sum()) * CELL * CELL
        if area >= 0.12:
            out.append(f"{c['label']} ({area:.2f} m² em ({(c['minX'] + c['maxX']) / 2:.1f}, {(c['minZ'] + c['maxZ']) / 2:.1f}))")
    return out


def walk_through_geometry(grid: "Grid", seen: np.ndarray, solid: dict) -> float:
    """Área (m²) de geometria que deveria barrar e onde o centro do jogador consegue estar."""
    return float((seen & solid["block"]).sum()) * CELL * CELL


def wall_lines(city: dict) -> list[tuple[float, float, float, float]]:
    """Linhas de centro das muralhas, lidas do retângulo do terreno e das muralhas internas do mapa."""
    t = city["terrain"]
    x0, x1, z0, z1 = t["minX"] + 3.0, t["maxX"] - 3.0, t["minZ"] + 3.0, t["maxZ"] - 3.0
    out = [(x0, z0, x1, z0), (x0, z1, x1, z1), (x0, z0, x0, z1), (x1, z0, x1, z1)]
    # Muralha Velha e frente do castelo: linhas horizontais formadas pelos módulos com essas tags
    for tag in ("city_wall", "castle_wall"):
        zs = sorted({round(i["p"][2], 1) for i in city["instances"] if i.get("tag") == tag and abs(i.get("r", 0.0)) < 0.01})
        for z in zs:
            if abs(z - z0) < 1 or abs(z - z1) < 1:
                continue
            xs = [i["p"][0] for i in city["instances"] if i.get("tag") == tag and abs(round(i["p"][2], 1) - z) < 0.05]
            out.append((min(xs), z, max(xs), z))
    return out


def wall_gaps(city: dict, lines: list) -> list[str]:
    """Pontos da linha da muralha a mais de 0,6 m de qualquer pedra (módulo, torre ou portão) até 4 m de altura."""
    sys.path.insert(0, str(ROOT / "tools"))
    from footprint import body_points  # noqa: E402
    pts = []
    for inst in city["instances"]:
        tag = inst.get("tag", "")
        if tag in ("city_wall", "castle_wall") or tag.startswith("b:"):
            url = city["models"][inst["m"]]["url"]
            p = body_points(ROOT / "public" / url.lstrip("./"), inst, lo=0.3, hi=4.0)
            if len(p):
                pts.append(p[:, [0, 2]])
    # Torres e casas são ocas por dentro: o miolo do colisor de um prédio (Col_<chave>) também é pedra
    keys = {inst["tag"][2:] for inst in city["instances"] if inst.get("tag", "").startswith("b:")}
    for c in city["colliders"]:
        # ...e o vão de um portão (grade ou folha) fecha a linha da muralha
        if c["label"][4:] in keys or c["label"] == "Col_Gate" or c["label"].startswith("Gate_"):
            gx, gz = np.meshgrid(np.arange(c["minX"], c["maxX"], 0.25), np.arange(c["minZ"], c["maxZ"], 0.25), indexing="ij")
            pts.append(np.stack([gx.ravel(), gz.ravel()], axis=1))
    allp = np.concatenate(pts)
    cell = 0.5
    occ = set(zip(np.floor(allp[:, 0] / cell).astype(int).tolist(), np.floor(allp[:, 1] / cell).astype(int).tolist()))
    gaps = []
    for ax, az, bx, bz in lines:
        n = max(2, int(math.hypot(bx - ax, bz - az) / 0.25))
        for k in range(n + 1):
            x, z = ax + (bx - ax) * k / n, az + (bz - az) * k / n
            i, j = int(math.floor(x / cell)), int(math.floor(z / cell))
            if not any((i + di, j + dj) in occ for di in (-1, 0, 1) for dj in (-1, 0, 1)):
                gaps.append(f"({x:.1f}, {z:.1f})")
    return gaps


def terrain_vertex_height(city: dict, x: np.ndarray, z: np.ndarray) -> np.ndarray:
    """Altura de um vértice da malha do terreno: mesma fórmula do world.js (buildGround), parâmetros de terrain.hill."""
    t = city["terrain"]
    hill = t["hill"]
    d_wall = np.maximum.reduce([t["minX"] - x, x - t["maxX"], t["minZ"] - z, z - t["maxZ"]])
    f = np.where(d_wall > 0, np.minimum(1.0, np.maximum(d_wall, 0.0) / hill["ramp"]) ** hill["power"], 0.0)
    for fz in city.get("flatZones", []):
        d = np.maximum.reduce([fz["minX"] - x, x - fz["maxX"], fz["minZ"] - z, z - fz["maxZ"]])
        f = f * np.clip(d / (fz.get("blend") or hill["blend"]), 0.0, 1.0)
    h = hill["base"] + f * (hill["rise"] + np.sin(x * hill["freqX"]) * np.cos(z * hill["freqZ"]) * hill["amp"])
    return h.astype(np.float32).astype(np.float64)


def terrain_mesh_height(city: dict, x: np.ndarray, z: np.ndarray) -> np.ndarray:
    """Altura do terreno como a GPU desenha: PlaneGeometry(size, size, seg, seg) deitado (rotateX(-pi/2)) e
    transladado para (cx, cz), vértices em float32; dentro de cada quad (a, b, c, d) os triângulos são (a, b, d) e
    (b, c, d), com a diagonal de (ix, iz + 1) a (ix + 1, iz). A altura num ponto é a interpolação no triângulo."""
    t = city["terrain"]
    size = float(t["size"])
    seg = int(math.floor(size / t["hill"]["cell"] + 0.5))
    sw = size / seg
    vx = (np.float32(np.arange(seg + 1) * sw - size / 2) + np.float32(t["cx"])).astype(np.float32).astype(np.float64)
    vz = (np.float32(np.arange(seg + 1) * sw - size / 2) + np.float32(t["cz"])).astype(np.float32).astype(np.float64)
    gx, gz = np.meshgrid(vx, vz, indexing="ij")
    hv = terrain_vertex_height(city, gx, gz)
    u = (x - vx[0]) / sw
    v = (z - vz[0]) / sw
    i = np.clip(np.floor(u).astype(int), 0, seg - 1)
    j = np.clip(np.floor(v).astype(int), 0, seg - 1)
    fu = np.clip(u - i, 0.0, 1.0)
    fv = np.clip(v - j, 0.0, 1.0)
    ha, hb, hc, hd = hv[i, j], hv[i, j + 1], hv[i + 1, j + 1], hv[i + 1, j]
    lower = ha + fu * (hd - ha) + fv * (hb - ha)
    upper = hc + (1.0 - fu) * (hb - hc) + (1.0 - fv) * (hd - hc)
    return np.where(fu + fv <= 1.0, lower, upper)


def reachable_relief(city: dict, grid: "Grid", seen: np.ndarray) -> tuple[float, float, float, float]:
    """(altura máxima, x, z, área em m² acima do teto) do terreno sob as células alcançáveis."""
    ii, jj = np.nonzero(seen)
    px, pz = grid.xs[ii], grid.zs[jj]
    h = terrain_mesh_height(city, px, pz)
    k = int(np.argmax(h))
    return float(h[k]), float(px[k]), float(pz[k]), float((h > TERRAIN_MAX_REACHABLE).sum()) * CELL * CELL


def _segment_samples(ax: float, az: float, bx: float, bz: float, step: float = 0.5) -> list[tuple[float, float]]:
    n = max(1, int(math.hypot(bx - ax, bz - az) / step))
    return [(ax + (bx - ax) * k / n, az + (bz - az) * k / n) for k in range(n + 1)]


def creature_problems(city: dict, npcs: dict, enemy_types: dict, grid: "Grid", seen: np.ndarray,
                      spawns: list[dict]) -> list[str]:
    """Spawns, patrulhas, fauna e renascimentos: alcançáveis, hostis fora da muralha e longe de missão/NPC."""
    t = city["terrain"]
    nodes = city["nav"]["nodes"]
    keep_away = [(f"coletável {k}", c["p"][0], c["p"][2]) for k, c in city["collectibles"].items()]
    posts = {s["to"] for n in npcs["npcs"].values() for s in n["rotina"]} | {p for r in npcs["figurantes"]["rotas"] for p in r["pontos"]}
    keep_away += [(f"nó {k}", nodes[k]["x"], nodes[k]["z"]) for k in posts]
    out = []

    def on_foot(label: str, x: float, z: float) -> None:
        if grid.reach(seen, x, z) > 0.3:
            out.append(f"{label} fora da área alcançável ({x:.1f}, {z:.1f})")

    def loop(label: str, pts: list[list[float]]) -> None:
        for k, (ax, az) in enumerate(pts):
            bx, bz = pts[(k + 1) % len(pts)]
            if len(pts) > 1 and any(grid.reach(seen, x, z) > 0.3 for x, z in _segment_samples(ax, az, bx, bz)):
                out.append(f"{label}: trecho ({ax:.1f}, {az:.1f}) -> ({bx:.1f}, {bz:.1f}) atravessa obstáculo")

    for e in spawns:
        d = enemy_types.get(e["tipo"])
        if d is None:
            out.append(f"{e['id']}: tipo inexistente {e['tipo']}")
            continue
        hostile = not d.get("treino")
        pts = [[e["x"], e["z"]]] + [p for p in e.get("patrulha", []) if p != [e["x"], e["z"]]]
        for x, z in pts:
            on_foot(e["id"], x, z)
            if hostile and t["minX"] <= x <= t["maxX"] and t["minZ"] <= z <= t["maxZ"]:
                out.append(f"{e['id']} hostil dentro da muralha ({x:.1f}, {z:.1f})")
            if hostile:
                for name, kx, kz in keep_away:
                    if math.hypot(kx - x, kz - z) < CREATURE_CLEAR:
                        out.append(f"{e['id']} a {math.hypot(kx - x, kz - z):.1f} m de {name}")
        loop(e["id"], e.get("patrulha") or [])
    for f in city.get("fauna", []):
        for x, z in f["pontos"]:
            on_foot(f["id"], x, z)
        loop(f["id"], f["pontos"])
    for key, r in city.get("respawns", {}).items():
        on_foot(f"renascimento {key}", r["x"], r["z"])
    return out


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass
    city = json.loads(CITY.read_text(encoding="utf-8"))
    npcs = json.loads(NPCS.read_text(encoding="utf-8"))
    failures: list[str] = []

    def check(cond: bool, msg: str) -> None:
        print(f"  [{'OK' if cond else 'FALHA'}] {msg}")
        if not cond:
            failures.append(msg)

    cols = body_colliders(city)
    nodes = city["nav"]["nodes"]
    print(f"=== 1. Rotas dos NPCs ({len(nodes)} nós, {len(city['nav']['edges'])} arestas, {len(cols)} colisores) ===")
    bad = []
    for a, b in city["nav"]["edges"]:
        na, nb = nodes[a], nodes[b]
        n = max(2, int(np.hypot(nb["x"] - na["x"], nb["z"] - na["z"]) / 0.1))
        t = np.linspace(0, 1, n + 1)
        # Ponta de assento (banquetas/cadeiras) fica encostada no móvel de propósito: ignora os 0,4 m finais
        trim_a = 0.4 / max(1e-6, np.hypot(nb["x"] - na["x"], nb["z"] - na["z"])) if "seatY" in na else 0
        trim_b = 0.4 / max(1e-6, np.hypot(nb["x"] - na["x"], nb["z"] - na["z"])) if "seatY" in nb else 0
        t = t[(t >= trim_a) & (t <= 1 - trim_b)]
        px = na["x"] + (nb["x"] - na["x"]) * t
        pz = na["z"] + (nb["z"] - na["z"]) * t
        clearance = float(dist_to_boxes(px, pz, cols).min()) if len(t) else 1.0
        if clearance < NPC_RADIUS:
            bad.append(f"{a} -> {b} ({clearance:.2f} m)")
    check(not bad, f"todas as arestas mantêm folga >= {NPC_RADIUS} m" + (f"; falham: {bad}" if bad else ""))

    print("=== 2. Alcance a pé a partir do spawn ===")
    grid = Grid(city, cols)
    sp = city["spawn"]
    seen = grid.flood(sp["x"], sp["z"])
    check(seen.sum() > 30_000, f"{int(seen.sum())} células alcançáveis ({seen.sum() * CELL * CELL:.0f} m²)")
    targets: dict[str, tuple[float, float]] = {}
    for npc_id, npc in npcs["npcs"].items():
        for step in npc["rotina"]:
            n = nodes[step["to"]]
            targets[f"{npc_id}@{step['to']}"] = (n["x"], n["z"])
    for key, c in city["collectibles"].items():
        targets[f"coletável:{key}"] = (c["p"][0], c["p"][2])
    for it in city["interactables"]:
        targets[f"interação:{it['key']}"] = (it["p"][0], it["p"][2])
    unreachable = []
    for name, (x, z) in targets.items():
        reach = TALK_REACH if "@" in name else 1.3
        d = grid.reach(seen, x, z)
        if d > reach:
            unreachable.append(f"{name} ({d:.2f} m)")
    check(not unreachable, f"{len(targets)} alvos (postos dos NPCs, coletáveis, quadro) ao alcance" + (f"; fora: {unreachable}" if unreachable else ""))
    counter = nodes["inn_bram"]
    yard = city["collectibles"]["lenha_patio"]["p"]
    check(grid.reach(seen, counter["x"], counter["z"]) <= TALK_REACH and grid.reach(seen, yard[0], yard[2]) <= 1.3,
          "balcão da estalagem (porta da frente) e lenha do pátio (porta dos fundos) alcançáveis")
    door = [c for c in city["colliders"] if c["label"].startswith("Col_Inn_S2")]
    check(len(door) == 2, f"porta da frente da estalagem tem dois batentes ({len(door)})")
    # Fecha a porta pelo mesmo colisor de folha que o jogo liga quando o jogador fecha a porta
    front = next(d for d in city["doors"] if d["id"] == "Inn:S2")
    check(front["enterable"] and front["open"] and any(c.get("door") == "Inn:S2" for c in city["colliders"]),
          "porta da frente da estalagem é uma porta de verdade (abre, fecha e tem colisor de folha)")
    neg = Grid(city, body_colliders(city, closed={"Inn:S2"}))
    seen_neg = neg.flood(sp["x"], sp["z"])
    # O pátio só tem acesso pelo salão (como no mapa original): fechar a porta da frente isola os dois
    check(neg.reach(seen_neg, counter["x"], counter["z"]) > TALK_REACH and neg.reach(seen_neg, yard[0], yard[2]) > 1.3,
          "controle negativo: com a porta da frente fechada, balcão e pátio ficam inalcançáveis (paredes e cerca são sólidas)")

    print("=== 3. Barreiras invisíveis (colisor sem geometria na altura do corpo) ===")
    solid = geometry_mask(city, grid)
    walls = invisible_walls(grid, seen, solid, cols)
    check(not walls, "nenhum colisor na beira de área andável está longe de geometria visível"
          + (f"; invisíveis: {walls}" if walls else ""))
    # Controle negativo: um colisor plantado no meio da praça, sem nada visível em cima, tem de ser pego
    ghost = {"label": "Col_Fantasma", "minX": 5.5, "maxX": 7.5, "minZ": 5.5, "maxZ": 7.5, "minY": 0, "maxY": 3}
    g2 = Grid(city, cols + [ghost])
    s2 = g2.flood(sp["x"], sp["z"])
    caught = invisible_walls(g2, s2, solid, cols + [ghost])
    check(any(w.startswith("Col_Fantasma") for w in caught), "controle negativo: colisor fantasma na praça é detectado")
    walkthrough = walk_through_geometry(grid, seen, solid)
    check(walkthrough < 2.0, f"geometria sólida atravessável pelo jogador: {walkthrough:.2f} m² (teto 2 m²)")

    print("=== 4. Muralhas fechadas (sem frestas entre módulos e torres) ===")
    lines = wall_lines(city)
    gaps = wall_gaps(city, lines)
    check(not gaps, f"{len(lines)} linhas de muralha cobertas de pedra a cada 0,25 m" + (f"; frestas: {gaps[:8]}" if gaps else ""))
    # Controle negativo: tirar um módulo da muralha leste precisa abrir uma fresta detectável
    victim = next(i for i, inst in enumerate(city["instances"]) if inst.get("tag") == "city_wall" and inst["p"][0] > 60 and -40 < inst["p"][2] < 0)
    holed = dict(city, instances=[inst for i, inst in enumerate(city["instances"]) if i != victim])
    check(bool(wall_gaps(holed, lines)), "controle negativo: sem um módulo da muralha leste, a fresta aparece")

    print("=== 5. Integridade do pacote ===")
    missing = [m["url"] for m in city["models"].values() if not (ROOT / "public" / m["url"].lstrip("./")).is_file()]
    check(not missing, f"{len(city['models'])} modelos presentes em public/" + (f"; faltam {missing}" if missing else ""))
    chars = {d["modelo"] for d in npcs["npcs"].values()} | {t["modelo"] for t in npcs["figurantes"]["tipos"]}
    miss_chars = [c for c in chars if not (ROOT / "public" / "assets" / "kits" / "chars" / f"{c}.glb").is_file()]
    check(not miss_chars, f"corpos de personagem presentes ({sorted(chars)})")
    check(city["stats"]["triangles"] <= TRIANGLE_BUDGET, f"{city['stats']['triangles']} triângulos (teto {TRIANGLE_BUDGET})")
    runtime = city.get("runtimeModels", {})
    miss_rt = [u for u in runtime.values() if not (ROOT / "public" / u.lstrip("./")).is_file()]
    need_rt = {"adv/sword_1handed", "adv/staff", "pets/animal-hog", "pets/animal-dog", "dungeon/sword_shield_broken"}
    check(not miss_rt and need_rt <= set(runtime), f"{len(runtime)} modelos de runtime (inimigos, fauna, armas) presentes"
          + (f"; faltam {miss_rt or sorted(need_rt - set(runtime))}" if miss_rt or not need_rt <= set(runtime) else ""))
    bins = [ROOT / "public" / "assets" / "kits" / "adv" / "sword_1handed.bin", ROOT / "public" / "assets" / "kits" / "pets" / "Textures" / "colormap.png"]
    check(all(b.is_file() for b in bins), "buffers e texturas dos modelos de runtime copiados (sword_1handed.bin, pets/Textures/colormap.png)")

    print(f"=== 6. Relevo sob a área andável (teto {TERRAIN_MAX_REACHABLE} m, malha da GPU) ===")
    hmax, hx, hz, harea = reachable_relief(city, grid, seen)
    check(hmax <= TERRAIN_MAX_REACHABLE, f"relevo máximo alcançável {hmax:.2f} m em ({hx:.1f}, {hz:.1f}); {harea:.0f} m² acima do teto")
    sope = [c for c in cols if c["label"].startswith("Col_Sope_")]
    check(len(sope) > 0, f"sopé perimetral com {len(sope)} colisores de rocha/tronco")
    # Controle negativo: o mesmo mapa sem o sopé deixa o jogador entrar nos corredores fora da muralha, onde o morro sobe
    g_open = Grid(city, [c for c in cols if not c["label"].startswith("Col_Sope_")])
    s_open = g_open.flood(sp["x"], sp["z"])
    omax, ox, oz, oarea = reachable_relief(city, g_open, s_open)
    check(omax > TERRAIN_MAX_REACHABLE, f"controle negativo: sem o sopé, relevo alcançável sobe a {omax:.2f} m em ({ox:.1f}, {oz:.1f}); {oarea:.0f} m² acima do teto")

    print("=== 7. Criaturas, fauna e renascimento ===")
    enemy_types = json.loads(ENEMIES.read_text(encoding="utf-8"))["inimigos"]
    spawns = city.get("enemySpawns", [])
    hostile = [e for e in spawns if not enemy_types.get(e["tipo"], {}).get("treino")]
    counts: dict[str, int] = {}
    for e in spawns:
        counts[e["tipo"]] = counts.get(e["tipo"], 0) + 1
    check(len(hostile) >= 8 and counts.get("guardiao") == 1 and counts.get("boneco", 0) >= 1,
          f"{len(spawns)} spawns ({', '.join(f'{k}: {v}' for k, v in sorted(counts.items()))})")
    check(len({e["id"] for e in spawns}) == len(spawns), "ids de spawn únicos")
    treino = city["zones"][[z["key"] for z in city["zones"]].index("TreinoZ")]
    check(all(treino["minX"] <= e["x"] <= treino["maxX"] and treino["minZ"] <= e["z"] <= treino["maxZ"] for e in spawns if e["tipo"] == "boneco"),
          "bonecos de treino dentro do Campo de Treino")
    probs = creature_problems(city, npcs, enemy_types, grid, seen, spawns)
    check(not probs, f"{len(spawns)} spawns + patrulhas, {len(city.get('fauna', []))} laços de fauna e {len(city.get('respawns', {}))} renascimentos alcançáveis, hostis fora da muralha e longe de missão/NPC"
          + (f"; problemas: {probs[:10]}" if probs else ""))
    check(set(city.get("respawns", {})) >= {"cidade", "acampamento"}, "renascimentos 'cidade' e 'acampamento' definidos")
    # Controle negativo: um javali plantado na Praça e um slime atrás do sopé (corredor leste fora da muralha)
    bad_spawns = spawns + [{"id": "teste_praca", "tipo": "javali", "x": 3.0, "z": 0.0, "patrulha": []},
                           {"id": "teste_sope", "tipo": "slime", "x": 100.0, "z": 30.0, "patrulha": []}]
    caught = creature_problems(city, npcs, enemy_types, grid, seen, bad_spawns)
    check(any("teste_praca hostil dentro da muralha" in p for p in caught) and any(p.startswith("teste_sope fora da área alcançável") for p in caught),
          "controle negativo: javali na Praça e slime atrás do sopé são apontados")

    print()
    if failures:
        print(f">>> {len(failures)} FALHA(S)")
        return 1
    print(">>> CIDADE VALIDADA SOBRE OS DADOS QUE O JOGO CARREGA <<<")
    return 0


if __name__ == "__main__":
    sys.exit(main())
