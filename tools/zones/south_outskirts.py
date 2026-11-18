"""Regiões extramuros ao sul de Cinzas de Alvor:
- Estrada Velha do Sul (saída do Portão Sul, posto avançado, santuário, carroça)
- Acampamento da Caravana (fogueira central, tendas, bancos de tronco, baú)
- Vale do Ribeirão & Moinho d'Água (rio, ponte de tábuas com guarda-corpo, moinho giratório)
- Mata Cinzenta & Ruínas do Marco Antigo (bosque nebuloso, cogumelos, fauna, anel de ruínas e monólito)
"""
from __future__ import annotations

import math
import random

K = 2.8
KK = 0.8
PI = math.pi
FACE = {"S": 0.0, "N": PI, "E": PI / 2, "W": -PI / 2}

# Planície jogável extramuros ao sul — FONTE ÚNICA da borda andável fora da muralha. city_layout.py tira daqui o
# 'walk' (minX/maxX/maxZ); a flatZone é a planície alargada por FOOT_MARGIN (o relevo só começa a subir depois do
# sopé); o sopé de rochas (Col_Sope_*) fica sobre a borda e fecha também os corredores ao norte da planície, fora
# das muralhas leste e oeste, onde o terreno já é morro (medido: até 8,96 m de relevo alcançável sem esse fecho).
PLAIN = {"minX": -125.0, "maxX": 125.0, "minZ": 64.0, "maxZ": 185.0}
FOOT_MARGIN = 6.0          # planície plana além da borda andável, antes de o morro começar a subir
FOOT_BLEND = 14.0          # distância em que o morro vai de 0 à altura cheia depois da planície
RIDGE_OFFSET = 1.2         # centro das rochas do sopé além da borda andável (a face interna fica ~1 m para dentro)
RIDGE_STEP = 2.2           # espaçamento das rochas (menor que a menor pegada: sem fresta para o raio do jogador)
WALL_CORNER_X = 69.6       # primeira rocha do fecho norte encosta na torre de canto da muralha sul (x 63,15..68,85)


def _ridge(c, key: str, rng: random.Random, x0: float, z0: float, x1: float, z1: float, outward: tuple[float, float]) -> None:
    """Paredão de rochas no sopé entre (x0, z0) e (x1, z1). Cada rocha tem colisor pela própria pegada na altura do
    corpo (sem barreira invisível); por trás (lado 'outward'), árvores secas e lascas altas fazem a silhueta da encosta
    e, por dentro, um tronco caído de vez em quando quebra a repetição."""
    length = math.hypot(x1 - x0, z1 - z0)
    n = max(1, int(math.ceil(length / RIDGE_STEP)))
    ox, oz = outward
    for k in range(n + 1):
        t = k / n
        x = x0 + (x1 - x0) * t
        z = z0 + (z1 - z0) * t
        if k % 3 == 2:
            c.place("kenney", "rock-wide", x + ox * 0.3, 0.0, z + oz * 0.3, rng.uniform(0, 2 * PI),
                    [rng.uniform(2.5, 2.9), rng.uniform(1.4, 1.9), rng.uniform(2.0, 2.4)], pal="pedra_escura", tag="rock",
                    collide=f"Col_Sope_{key}_{k}")
        else:
            c.place("kenney", "rock-large", x, 0.0, z, rng.uniform(0, 2 * PI),
                    [rng.uniform(2.2, 2.6), rng.uniform(1.3, 2.0), rng.uniform(2.2, 2.6)], pal="pedra_escura", tag="rock",
                    collide=f"Col_Sope_{key}_{k}")
        if k % 4 == 1:
            # Silhueta da encosta (fora do alcance: sem colisor, a rocha da frente já barra)
            c.place("forest", rng.choice(("Tree_Bare_1_A_Color1", "Tree_Bare_2_A_Color1", "Tree_5_A_Color1")),
                    x + ox * rng.uniform(3.5, 5.5), 0.0, z + oz * rng.uniform(3.5, 5.5), rng.uniform(0, 2 * PI),
                    rng.uniform(1.2, 1.6), tag="forest")
        if k % 11 == 6:
            c.place("dungeon", "trunk_large_A", x - ox * 2.1, 0.0, z - oz * 2.1, math.atan2(x1 - x0, z1 - z0) + PI / 2 + rng.uniform(-0.25, 0.25),
                    [1.6, 0.8, 0.9], tag="rock", collide=f"Col_Sope_{key}_Tronco_{k}")


def _perimeter(c, rng: random.Random) -> None:
    """Sopé em volta da planície: leste, sul, oeste e os dois fechos ao norte (da torre de canto até a borda)."""
    x0, x1 = PLAIN["minX"] - RIDGE_OFFSET, PLAIN["maxX"] + RIDGE_OFFSET
    zs = PLAIN["maxZ"] + RIDGE_OFFSET
    zn = PLAIN["minZ"] - 0.8
    _ridge(c, "NL", rng, WALL_CORNER_X, zn, x1, zn, (0.0, -1.0))
    _ridge(c, "L", rng, x1, zn, x1, zs, (1.0, 0.0))
    _ridge(c, "S", rng, x1, zs, x0, zs, (0.0, 1.0))
    _ridge(c, "O", rng, x0, zs, x0, zn, (-1.0, 0.0))
    _ridge(c, "NO", rng, x0, zn, -WALL_CORNER_X, zn, (0.0, -1.0))


def build(c) -> None:
    rng = random.Random(2026)

    def kk(name: str, x: float, z: float, face: str = "S", s=KK, y: float = 0.0, collide: str | None = None,
           pad: float = 0.0, tag: str = "", r: float | None = None, kit: str = "dungeon", hinge: dict | None = None):
        rot = FACE[face] if r is None else r
        return c.place(kit, name, x, y, z, rot, s, tag=tag, collide=collide, pad=pad, hinge=hinge)

    # Planície nivelada para toda a região jogável extramuros ao sul (borda andável + margem até o sopé)
    c.flat_zone(PLAIN["minX"] - FOOT_MARGIN, PLAIN["minZ"] - FOOT_MARGIN, PLAIN["maxX"] + FOOT_MARGIN,
                PLAIN["maxZ"] + FOOT_MARGIN, blend=FOOT_BLEND)
    _perimeter(c, random.Random(4242))

    # ==================================================================
    # A. ESTRADA VELHA DO SUL (x: -22..22, z: 66..120)
    # ==================================================================
    c.dirt_road(-4.5, 66.0, 4.5, 132.0)
    c.dirt_road(-75.0, 106.0, 75.0, 112.0)
    # Emendas até a ponte do Ribeirão e continuação a leste
    c.dirt_road(74.0, 106.0, 82.0, 112.0)
    c.dirt_road(92.0, 106.0, 112.0, 112.0)

    c.zone("EstradaVelha", -20.0, 68.0, 20.0, 118.0, "Estrada Velha do Sul",
           "Rota das Caravanas · Fronteira de Alvor", priority=1, marco="EstradaVelha")

    # Posto avançado de vigia fora do portão (lado oeste da estrada)
    c.building("PostoSul", -16.8, 72.0, 2, 1, floors=1, ridge="x", pal="pedra_escura", style="wood",
               room="armazem", doors=[(-11.2, 73.4)], awning=True)
    kk("crates_stacked", -10.5, 75.4, s=0.45, collide="Col_PostoSul_Crates")
    kk("barrel_large", -10.6, 71.4, s=0.45, collide="Col_PostoSul_Barrel")

    # Lampiões ao longo da estrada
    for name, (x, z) in (("sul_1o", (-5.2, 76.0)), ("sul_1l", (5.2, 76.0)),
                         ("sul_2o", (-5.2, 92.0)), ("sul_2l", (5.2, 103.5)),
                         ("sul_enc", (-5.5, 113.5))):
        c.lamp(name, x, z)

    # Placa da encruzilhada (canto NE do cruzamento, fora da estrada)
    kk("post", 5.4, 104.6, s=[0.3, 0.55, 0.3], collide="Col_Placa_Enc_Post")
    c.place_centered("kenney", "wall-wood", 5.4, 0.9, 104.6, PI / 4, [0.55, 0.4, 0.55],
                     pal="base", tag="sign", collide="Col_Placa_Enc")
    c.interactable("placa_encruzilhada", "sign", 4.4, 105.6, "Ler a placa da encruzilhada", reach=1.8,
                   title="Encruzilhada do Sul",
                   text="↑ Norte: Portão Sul de Cinzas de Alvor | ← Oeste: Mata Cinzenta & Ruínas do Marco Antigo | → Leste: Acampamento da Caravana & Vale do Ribeirão")

    # Santuário do Viajante em (9.0, 92.0) — pilar esculpido com âncora, luz e oração
    kk("pillar_decorated", 9.0, 92.0, s=[0.55, 0.52, 0.55], collide="Col_Shrine_Road")
    c.place("dungeon", "floor_tile_large", 9.0, -0.02, 92.0, 0.0, [0.85, 1.0, 0.85], tag="passable", cast=False)
    c.anchor("ShrineRoad", 9.0, 0.0, 92.0, shrine=1)
    c.light("SantuarioEstrada", 9.0, 2.6, 92.0, "#7ce8ff", 7.0, 12.0, flicker=0.06, importance=1.4, pool=4.0, glow=1.6)
    c.glows.append({"key": "ShrineRoadGlow", "p": [9.0, 2.2, 92.0], "color": "#7ce8ff", "size": 1.3})
    c.interactable("santuario_estrada", "shrine", 9.0, 90.6, "Rezar no Santuário do Viajante",
                   reach=1.8, restore={"vigor": 50, "calor": 60})

    # Carroça de mercador avariada e suprimentos coletáveis
    c.place("kenney", "cart-high", -8.5, 0.0, 102.0, 0.65, 2.0, pal="base", tag="cart",
            collide="Col_Cart_Estrada", pad=-0.05)
    kk("crate_small", -10.0, 101.0, r=0.25, s=0.5, collide="Col_Cart_Estrada_Crates")
    c.collectible("suprimentos_estrada", -6.8, 101.2, [
        {"kit": "dungeon", "name": "crate_small", "x": -6.8, "z": 101.2, "r": 0.3, "s": 0.45},
    ], reach=1.5)
    c.glows.append({"key": "SuprimentosEstradaGlow", "p": [-6.8, 0.45, 101.2], "color": "#ffd27a",
                    "size": 0.9, "collect": "suprimentos_estrada"})

    # Vegetação de margem da Estrada Velha (afastada do leito da estrada)
    for x, z, model, s in ((-14.0, 84.0, "Tree_3_A_Color1", 1.15), (14.5, 80.0, "Tree_5_A_Color1", 1.1),
                           (-15.5, 96.0, "Tree_1_A_Color1", 1.2), (15.5, 99.0, "Tree_4_A_Color1", 1.1),
                           (-13.5, 118.0, "Tree_2_A_Color1", 1.15), (13.0, 120.0, "Tree_6_A_Color1", 1.1)):
        c.tree(model, x, z, s=s, r=rng.uniform(0, 2 * PI))
        c.place("forest", "Bush_2_A_Color1", x + 1.3, 0.0, z + 0.8, rng.uniform(0, 2 * PI), 1.4, tag="bush", cast=False)

    # ==================================================================
    # B. ACAMPAMENTO DA CARAVANA (x: 24..72, z: 82..132)
    # ==================================================================
    c.dirt_road(26.0, 96.0, 62.0, 122.0)
    c.zone("Acampamento", 24.0, 84.0, 72.0, 130.0, "Acampamento da Caravana",
           "Mercadores, Fogueira & Aventureiros", priority=1, marco="Acampamento")

    # Fogueira central em (44.0, 108.0)
    kk("rocks_decorated", 44.0, 108.0, s=0.55, collide="Col_Camp_FireRocks")
    c.anchor("CampFire", 44.0, 0.35, 108.0, fire="campfire", size=1.2)
    c.light("AcampamentoFogo", 44.0, 1.4, 108.0, "#ff7b29", 15.0, 18.0,
            flicker=0.28, importance=2.2, pool=6.5, glow=1.2)
    c.interactable("fogueira_acampamento", "hearth", 44.0, 106.6,
                   "Aquecer-se na fogueira do acampamento", reach=1.9)

    # Bancos de tronco ao redor da fogueira (mantendo oeste e norte abertos para rota e interação)
    kk("trunk_medium_A", 44.0, 110.6, "E", s=[1.0, 0.65, 0.7], tag="seat", collide="Col_Camp_Log_S")
    c.interactable("tronco_camp_s", "seat", 44.0, 110.6, "Sentar no tronco junto à fogueira",
                   reach=1.5, look=[44.0, 108.0], seatY=0.0)
    kk("trunk_medium_A", 46.8, 108.0, "N", s=[1.0, 0.65, 0.7], tag="seat", collide="Col_Camp_Log_E")
    c.interactable("tronco_camp_e", "seat", 46.8, 108.0, "Sentar no tronco junto à fogueira",
                   reach=1.5, look=[44.0, 108.0], seatY=0.0)

    # Tendas customizadas com mobília real com colisor (sem colisores fantasma e sem transpassar a lona)
    # Tenda 1 (noroeste): tenda do mercador + barraca ao lado
    c.anchor("Tent1", 34.0, 0.0, 95.0, tent={"rot": 0.0, "color": "#c85a3a", "scale": 1.1})
    kk("bed_A_single", 33.3, 94.7, "S", s=0.65, collide="Col_Tent1_Bed")
    kk("crate_small", 34.6, 94.5, s=0.55, collide="Col_Tent1_Crate")
    c.place("kenney", "stall-red", 30.8, 0.0, 95.5, PI / 2, 1.8, pal="base", tag="stall",
            collide="Col_Tent1_Stall", pad=-0.05)
    kk("barrel_large", 36.2, 95.2, s=0.45, collide="Col_Tent1_Barrel")

    # Tenda 2 (nordeste): tenda dos aventureiros + armas apoiadas
    c.anchor("Tent2", 52.0, 0.0, 96.0, tent={"rot": -0.4, "color": "#3f6fc9", "scale": 1.15, "emblem": True})
    kk("bed_A_single", 51.6, 95.6, "S", s=0.65, collide="Col_Tent2_Bed")
    kk("crate_small", 52.5, 95.3, s=0.5, collide="Col_Tent2_Crate")
    kk("crates_stacked", 54.0, 96.6, s=0.45, collide="Col_Tent2_Crates")
    kk("barrel_small_stack", 50.0, 96.8, s=0.5, collide="Col_Tent2_Barrels")
    kk("crate_small", 53.7, 98.4, s=0.6, collide="Col_Tent2_WeaponCrate")
    c.place("adv", "sword_2handed_color", 53.7, 0.55, 98.4, 0.2, 0.65, tag="camp_gear")
    c.place("adv", "shield_round_color", 54.0, 0.52, 98.4, -0.3, 0.65, tag="camp_gear")

    # Tenda 3 (sudeste): suprimentos da caravana
    c.anchor("Tent3", 54.0, 0.0, 121.0, tent={"rot": PI, "color": "#4d8b55", "scale": 1.05})
    kk("crates_stacked", 54.0, 121.2, s=0.42, collide="Col_Tent3_Crates")
    kk("barrel_large_decorated", 56.2, 120.8, s=0.45, collide="Col_Tent3_Barrel")

    # Baú do acampamento (interação posicionada 1 m à frente do lado sul)
    kk("chest", 50.2, 99.6, "S", s=0.6, collide="Col_Chest_Acampamento",
       hinge={"key": "bau_acampamento", "node": "chest_lid", "axis": "x", "angle": -1.2, "dur": 0.7, "open": False})
    c.interactable("bau_acampamento", "chest", 50.2, 100.6, "Abrir o baú da caravana",
                   reach=1.8, hinge="bau_acampamento", loot="tesouro_acampamento")

    # Quadro de avisos da caravana
    c.place_centered("kenney", "wall-wood", 30.5, 0.75, 104.2, PI / 2, [0.9, 0.55, 0.9],
                     pal="base", tag="sign", collide="Col_Placa_Acampamento")
    kk("post", 29.5, 104.0, s=[0.3, 0.42, 0.3], collide="Col_Placa_Acamp_P1")
    kk("post", 31.5, 104.0, s=[0.3, 0.42, 0.3], collide="Col_Placa_Acamp_P2")
    c.interactable("placa_acampamento", "sign", 30.5, 105.4, "Ler o aviso da caravana", reach=1.8,
                   title="Acampamento da Caravana",
                   text="Caravana de Veren — Parada segura antes da ponte do Ribeirão. Mantenha a fogueira acesa contra a névoa fria.")

    # Carroça e lanternas do acampamento
    c.place("kenney", "cart", 39.0, 0.0, 121.0, 0.4, 2.0, pal="base", tag="cart",
            collide="Col_Cart_Camp", pad=-0.05)
    c.lamp("camp_1", 28.5, 105.2)
    c.lamp("camp_2", 59.0, 106.0)

    # Bordas arborizadas do acampamento
    for x, z, model in ((26.0, 88.0, "Tree_3_A_Color1"), (42.0, 87.5, "Tree_5_A_Color1"),
                        (60.0, 88.5, "Tree_1_A_Color1"), (29.0, 127.0, "Tree_4_A_Color1"),
                        (63.0, 126.0, "Tree_2_A_Color1")):
        c.tree(model, x, z, s=1.1, r=rng.uniform(0, 2 * PI))

    # ==================================================================
    # C. VALE DO RIBEIRÃO & MOINHO D'ÁGUA (x: 68..118, z: 72..142)
    # ==================================================================
    c.water_patch(82.0, 70.0, 92.0, 142.0, flow_x=0.0, flow_z=1.0)
    c.zone("Ribeirao", 68.0, 76.0, 114.0, 138.0, "Vale do Ribeirão",
           "Moinho d'Água & Ponte de Tábuas", priority=1, marco="Ribeirao")

    # Moinho d'água na margem oeste com roda giratória mergulhando no ribeirão
    c.building("MoinhoAgua", 70.8, 84.0, 4, 2, ridge="x", floors=2, pal="pedra_escura", style="wood",
               room="armazem", doors=[(71.8, 89.6)],
               title="Moinho do Ribeirão", sub="Roda d'Água · Grãos do Vale")
    c.place("kenney", "watermill-wide", 83.2, 1.85, 86.8, 0.0, 2.3, pal="pedra_escura",
            tag="watermill", dyn="spin:roda_ribeirao")
    kk("crates_stacked", 76.2, 90.4, s=0.45, collide="Col_MoinhoAgua_Crates")
    kk("barrel_large", 78.2, 90.4, s=0.45, collide="Col_MoinhoAgua_Barrel")
    c.lamp("ribeirao_moinho", 74.5, 92.5)

    # Ponte de tábuas em z = 106..112 cruzando x = 80..94
    for ix, px in enumerate((81.75, 85.25, 88.75, 92.25)):
        for iz, pz in enumerate((107.5, 110.5)):
            c.place("kenney", "planks", px, -0.02, pz, 0.0, [3.5, 1.0, 3.0],
                    pal="pedra_escura", tag="passable", cast=False)
    for k in range(5):
        fx = 80.0 + (k + 0.5) * (14.0 / 5)
        c.place_centered("kenney", "fence", fx, 0.0, 106.0, PI / 2, [K, K, 14.0 / 5],
                         pal="pedra_escura", tag="bridge_rail", collide=f"Col_Bridge_N{k}")
        c.place_centered("kenney", "fence", fx, 0.0, 112.0, -PI / 2, [K, K, 14.0 / 5],
                         pal="pedra_escura", tag="bridge_rail", collide=f"Col_Bridge_S{k}")

    c.lamp("ribeirao_ponte_o", 79.0, 105.0)
    c.lamp("ribeirao_ponte_l", 95.0, 105.0)
    c.interactable("vista_ribeirao", "vista", 87.0, 109.0, "Contemplar o Vale do Ribeirão",
                   reach=2.2, marco="Ribeirao", title="Ponte do Ribeirão Velho",
                   text="A roda do velho moinho range devagar sobre as águas escuras do Ribeirão. Daqui se vê toda a muralha sul de Cinzas de Alvor recortada contra a névoa.")

    # Rochas naturais nas margens do ribeirão (impedem atravessar a nado fora da ponte, sem colisores vazios)
    bank_z = [z for z in range(72, 105, 3)] + [z for z in range(114, 142, 3)]
    for k, rz in enumerate(bank_z):
        # Na altura do moinho (z 84..90) a própria parede leste do moinho protege a margem oeste
        if not (83.0 <= rz <= 90.0):
            c.place("kenney", "rock-wide" if k % 2 == 0 else "rock-large", 81.6, 0.0, float(rz),
                    (k % 4) * 0.4, [1.4, 1.0, 2.2], pal="pedra_escura", tag="rock",
                    collide=f"Col_Ribeirao_O_{k}")
        c.place("kenney", "rock-wide" if k % 2 == 1 else "rock-large", 92.4, 0.0, float(rz),
                (k % 3) * 0.5, [1.4, 1.0, 2.2], pal="pedra_escura", tag="rock",
                collide=f"Col_Ribeirao_L_{k}")
    # Fechamento rochoso nas extremidades norte e sul do leito
    for k, rx in enumerate((84.5, 87.0, 89.5)):
        c.place("kenney", "rock-wide", rx, 0.0, 70.5, 0.2 * k, [1.6, 1.1, 1.6],
                pal="pedra_escura", tag="rock", collide=f"Col_Ribeirao_N_{k}")
        c.place("kenney", "rock-wide", rx, 0.0, 141.5, 0.3 * k, [1.6, 1.1, 1.6],
                pal="pedra_escura", tag="rock", collide=f"Col_Ribeirao_S_{k}")

    # Margem leste além da ponte (área explorável)
    for x, z, model in ((99.0, 95.0, "Tree_3_A_Color1"), (107.0, 102.0, "Tree_5_A_Color1"),
                        (102.0, 118.0, "Tree_1_A_Color1"), (111.0, 126.0, "Tree_4_A_Color1"),
                        (98.0, 130.0, "Tree_2_A_Color1")):
        c.tree(model, x, z, s=1.15, r=rng.uniform(0, 2 * PI))
        c.place("forest", "Bush_3_A_Color1", x - 1.4, 0.0, z + 1.0, rng.uniform(0, 2 * PI), 1.4, tag="bush", cast=False)

    # ==================================================================
    # D. MATA CINZENTA & RUÍNAS DO MARCO ANTIGO (x: -115..-24, z: 76..178)
    # ==================================================================
    c.zone("MataCinzenta", -110.0, 76.0, -24.0, 135.0, "Mata Cinzenta",
           "Bosque Nebuloso · Árvores Retorcidas & Fungos", priority=1,
           marco="MataCinzenta", fog_boost=0.008, ambient_tint="#5b7c99")

    # Trilha principal para dentro da mata e rumo às ruínas
    c.dirt_road(-74.0, 110.0, -62.0, 168.0)

    # 3 Cogumelos brilhantes coletáveis na Mata Cinzenta
    mushrooms = [
        ("cogumelo_1", -42.0, 95.0),
        ("cogumelo_2", -84.0, 100.0),
        ("cogumelo_3", -48.0, 124.0),
    ]
    for key, mx, mz in mushrooms:
        c.collectible(key, mx, mz, [
            {"kit": "forest", "name": "Rock_1_A_Color1", "x": mx - 0.22, "z": mz + 0.12, "r": 0.4, "s": 0.9},
            {"kit": "forest", "name": "Bush_4_A_Color1", "x": mx + 0.18, "z": mz - 0.14, "r": -0.3, "s": 1.1},
        ], reach=1.5)
        c.glows.append({"key": f"Cogumelo_{key}", "p": [mx, 0.55, mz], "color": "#4ce8ff",
                        "size": 1.0, "collect": key})

    # Fauna da mata: viva (fauna.js), sem instância estática nem colisor. As clareiras abaixo (-46, 92), (-88, 96) e
    # (-52, 122) continuam reservadas na distribuição das árvores para o layout do bosque não mudar.

    # Árvores da Mata Cinzenta (mantendo corredores amplos nas trilhas e clareiras dos colecionáveis)
    forest_models = ("Tree_Bare_1_A_Color1", "Tree_Bare_2_A_Color1", "Tree_3_A_Color1", "Tree_5_A_Color1")
    tree_coords: list[tuple[float, float]] = []
    attempts = 0
    while len(tree_coords) < 52 and attempts < 600:
        attempts += 1
        tx = rng.uniform(-109.0, -25.0)
        tz = rng.uniform(77.0, 134.0)
        # Corredor da trilha leste-oeste e trilha norte-sul para as ruínas
        if 103.0 <= tz <= 115.0:
            continue
        if -76.0 <= tx <= -60.0 and tz >= 104.0:
            continue
        # Respeitar clareiras dos cogumelos e fauna
        if any(math.hypot(tx - px, tz - pz) < 3.5 for _, px, pz in mushrooms):
            continue
        if any(math.hypot(tx - px, tz - pz) < 3.0 for px, pz in ((-46.0, 92.0), (-88.0, 96.0), (-52.0, 122.0))):
            continue
        if any(math.hypot(tx - ox, tz - oz) < 4.6 for ox, oz in tree_coords):
            continue
        tree_coords.append((tx, tz))
        c.tree(rng.choice(forest_models), tx, tz, s=rng.uniform(1.05, 1.35), r=rng.uniform(0, 2 * PI))
        if rng.random() < 0.6:
            ang = rng.uniform(0, 2 * PI)
            c.place("forest", rng.choice(["Bush_1_A_Color1", "Bush_2_A_Color1", "Bush_3_A_Color1", "Grass_1_A_Color1"]),
                    tx + math.cos(ang) * 1.4, 0.0, tz + math.sin(ang) * 1.4,
                    rng.uniform(0, 2 * PI), rng.uniform(1.1, 1.8), tag="bush", cast=False)

    # Afloramentos rochosos da Mata Cinzenta
    rock_spots = [
        (-36.0, 88.0, "Rock_3_A_Color1", 1.8), (-56.0, 86.0, "Rock_4_A_Color1", 1.7),
        (-74.0, 90.0, "Rock_3_A_Color1", 1.9), (-95.0, 84.0, "Rock_4_A_Color1", 1.8),
        (-33.0, 122.0, "Rock_3_A_Color1", 1.8), (-82.0, 124.0, "Rock_4_A_Color1", 1.8),
        (-98.0, 119.0, "Rock_3_A_Color1", 1.9), (-102.0, 98.0, "Rock_4_A_Color1", 1.7),
    ]
    for k, (rx, rz, model, s) in enumerate(rock_spots):
        if any(math.hypot(rx - tx, rz - tz) < 2.2 for tx, tz in tree_coords):
            continue
        ry = 0.25 if model == "Rock_3_A_Color1" else 0.0
        c.place("forest", model, rx, ry, rz, rng.uniform(0, 2 * PI), s, tag="rock", collide=f"Col_Mata_Rock_{k}")

    # ------------------------------------------------------------------ Ruínas do Marco Antigo
    c.zone("RuinasMarco", -96.0, 135.0, -40.0, 178.0, "Ruínas do Marco Antigo",
           "Santuário Ancestral · Câmara Selada", priority=2, marco="RuinasMarco",
           fog_boost=0.011, ambient_tint="#4ecdc4")

    # Piso de lajes quebradas (passável) sob a praça do monólito
    for lx in (-72.0, -68.0, -64.0):
        for lz in (150.0, 154.0, 158.0):
            c.place("dungeon", "floor_tile_large", lx, -0.02, lz, 0.0, 1.0, tag="passable", cast=False)

    # Anel interno de colunas antigas em torno de (-68.0, 154.0) (abertura ampla a norte e para o baú a leste)
    for k, deg in enumerate((25, 65, 115, 155, 205, 235, 305, 335)):
        ang = math.radians(deg)
        px = -68.0 + 11.5 * math.cos(ang)
        pz = 154.0 + 11.5 * math.sin(ang)
        model = "pillar_decorated" if k % 2 == 0 else "column"
        kk(model, px, pz, r=ang + PI / 2, s=0.85 if model == "pillar_decorated" else 1.1,
           tag="ruin_pillar", collide=f"Col_Ruin_Pillar_{k}")

    # Anel externo de arcos e muros em ruínas (tag="ruin_wall" para não interferir nas muralhas da cidade)
    kk("wall_archedwindow_open", -74.0, 140.5, r=0.25, s=1.0, tag="ruin_wall", collide="Col_Ruin_ArchW")
    kk("wall_archedwindow_open", -62.0, 140.5, r=-0.25, s=1.0, tag="ruin_wall", collide="Col_Ruin_ArchE")
    kk("wall_broken", -82.5, 148.5, r=PI / 2, s=1.0, tag="ruin_wall", collide="Col_Ruin_WallW1")
    kk("wall_cracked", -82.5, 159.5, r=PI / 2, s=1.0, tag="ruin_wall", collide="Col_Ruin_WallW2")
    kk("wall_broken", -53.5, 148.5, r=PI / 2, s=1.0, tag="ruin_wall", collide="Col_Ruin_WallE1")
    kk("wall_cracked", -53.5, 159.5, r=PI / 2, s=1.0, tag="ruin_wall", collide="Col_Ruin_WallE2")
    kk("wall_cracked", -76.0, 168.0, r=-0.2, s=1.0, tag="ruin_wall", collide="Col_Ruin_WallS1")
    kk("wall_broken", -60.0, 168.0, r=0.2, s=1.0, tag="ruin_wall", collide="Col_Ruin_WallS2")

    # Escombros junto aos muros externos (longe das trilhas)
    kk("rubble_half", -80.5, 165.5, r=0.6, s=0.65, tag="ruin_rubble", collide="Col_Ruin_Rubble_SO")
    kk("rubble_half", -55.5, 165.5, r=-0.6, s=0.65, tag="ruin_rubble", collide="Col_Ruin_Rubble_SL")
    kk("rubble_large", -80.5, 142.5, r=-0.5, s=0.5, tag="ruin_rubble", collide="Col_Ruin_Rubble_NO")

    # Monólito Ancestral central em (-68.0, 154.0) (altura contida abaixo do cristal flutuante)
    kk("pillar_decorated", -68.0, 154.0, s=[1.0, 0.48, 1.0], tag="monolith", collide="Col_Monolith_Core")
    c.anchor("AncientMonolith", -68.0, 0.0, 154.0, monolith=1)
    c.light("RuinaMonolito", -68.0, 3.6, 154.0, "#46e8ff", 16.0, 24.0,
            flicker=0.12, importance=2.5, pool=7.5, glow=2.6)
    c.glows.append({"key": "MonolithGlow", "p": [-68.0, 2.8, 154.0], "color": "#46e8ff", "size": 2.0})
    c.interactable("inscricao_marco_antigo", "vista", -68.0, 151.6,
                   "Examinar as Runas do Marco Antigo", reach=1.8, marco="RuinasMarco",
                   title="Monólito do Marco Antigo",
                   text="Runas antigas pulsam em azul pálido na pedra gasta. Sob o musgo, o mesmo brasão da Praça do Marco — como se esta câmara selada fosse o alicerce esquecido de toda Alvor.")

    # Altar sul e Fragmento do Marco coletável
    kk("column", -68.0, 162.6, s=0.85, tag="ruin_pillar", collide="Col_Ruin_AltarPillar")
    c.collectible("fragmento_marco", -68.0, 161.2, [
        {"kit": "dungeon", "name": "rocks_small", "x": -68.0, "z": 161.2, "s": 0.45},
    ], reach=1.5)
    c.glows.append({"key": "FragmentoMarcoGlow", "p": [-68.0, 0.75, 161.2], "color": "#46e8ff",
                    "size": 1.3, "collect": "fragmento_marco"})

    # Baú dourado das ruínas (interação posicionada à frente no lado oeste)
    kk("chest_gold", -58.0, 154.0, "W", s=0.65, collide="Col_Chest_Ruinas",
       hinge={"key": "bau_ruinas", "node": "chest_gold_lid", "axis": "x", "angle": -1.2, "dur": 0.7, "open": False})
    c.interactable("bau_ruinas", "chest", -59.2, 154.0, "Abrir o baú das ruínas",
                   reach=1.8, hinge="bau_ruinas", loot="bau_ruinas_loot")

    # ==================================================================
    # NAVEGAÇÃO EXTRAMUROS (chaves exatas exigidas pela Frente D)
    # ==================================================================
    n = c.node
    n("portao_sul_vao", 0.0, 66.0)
    n("estrada_sul_1", 0.0, 78.0)
    n("estrada_sul_2", 0.0, 92.0)
    n("encruzilhada_sul", 0.0, 109.0)

    n("acampamento_entrada", 28.0, 109.0)
    n("acampamento_fogo", 41.5, 108.0, look=(44.0, 108.0))
    n("acampamento_sul", 44.0, 115.5)
    n("acampamento_leste", 61.0, 112.0)

    n("ribeirao_ponte", 76.0, 109.0)
    n("ribeirao_ponte_leste", 95.0, 109.0)
    n("moinho_agua_frente", 69.0, 94.0, look=(71.0, 88.0))

    n("mata_entrada", -34.0, 109.0)
    n("mata_clareira", -68.0, 109.0)
    n("ruinas_entrada", -68.0, 138.0)
    n("ruinas_altar", -68.0, 149.5, look=(-68.0, 154.0))

    c.link("portao_dentro", "portao_sul_vao", "estrada_sul_1", "estrada_sul_2", "encruzilhada_sul")
    c.link("encruzilhada_sul", "acampamento_entrada", "acampamento_fogo")
    c.link("acampamento_entrada", "acampamento_sul", "acampamento_leste", "ribeirao_ponte", "moinho_agua_frente")
    c.link("ribeirao_ponte", "ribeirao_ponte_leste")
    c.link("encruzilhada_sul", "mata_entrada", "mata_clareira", "ruinas_entrada", "ruinas_altar")
    # Patrulha dos aventureiros: trecho sul da Estrada Velha e volta pelo lado norte do acampamento
    n("estrada_sul_3", 0.0, 124.0)
    n("acampamento_norte", 40.0, 102.2)
    c.link("encruzilhada_sul", "estrada_sul_3")
    c.link("acampamento_entrada", "acampamento_norte", "acampamento_fogo")

    _creatures(c)
    _ambience(c)


def _creatures(c) -> None:
    """Inimigos (enemies.json) e fauna viva. Tudo extramuros, em células alcançáveis, longe dos postos dos NPCs, dos
    coletáveis de missão e da Estrada (test_city.py confere cada ponto e cada laço de patrulha)."""
    # Estrada Velha: javalis e slimes nos campos ao sul da encruzilhada, fora do leito da estrada
    c.enemy_spawn("javali_estrada_1", "javali", -16.0, 136.0, 0.4, [(-16.0, 136.0), (-22.0, 146.0), (-11.0, 150.0)])
    c.enemy_spawn("javali_estrada_2", "javali", 16.0, 140.0, -0.6, [(16.0, 140.0), (23.0, 150.0), (12.0, 156.0)])
    c.enemy_spawn("slime_estrada_1", "slime", -8.0, 168.0, 0.0, [(-8.0, 168.0), (-16.0, 174.0), (-2.0, 177.0)], leash=12.0)
    c.enemy_spawn("slime_estrada_2", "slime", 14.0, 172.0, 0.0, [(14.0, 172.0), (22.0, 166.0), (24.0, 176.0)], leash=12.0)
    # Vale do Ribeirão: slimes nas margens e um javali na várzea leste, além da ponte
    c.enemy_spawn("slime_ribeirao_1", "slime", 104.0, 88.0, 0.0, [(104.0, 88.0), (112.0, 80.0), (116.0, 92.0)], leash=12.0)
    c.enemy_spawn("slime_ribeirao_2", "slime", 110.0, 128.0, 0.0, [(110.0, 128.0), (117.0, 136.0), (104.0, 138.0)], leash=12.0)
    c.enemy_spawn("slime_ribeirao_3", "slime", 74.0, 150.0, 0.0, [(74.0, 150.0), (68.0, 158.0), (80.0, 160.0)], leash=12.0)
    c.enemy_spawn("javali_ribeirao_1", "javali", 106.0, 152.0, 1.2, [(106.0, 152.0), (115.0, 162.0), (99.0, 166.0)])
    # Mata Cinzenta: lobos no miolo do bosque, esqueletos nas bordas a caminho das ruínas
    c.enemy_spawn("lobo_mata_1", "lobo", -98.0, 84.0, 0.0, [(-98.0, 84.0), (-106.0, 90.0), (-96.0, 92.0)], leash=16.0)
    c.enemy_spawn("lobo_mata_2", "lobo", -60.0, 97.0, 0.0, [(-60.0, 97.0), (-67.0, 97.0), (-53.0, 93.0)], leash=16.0)
    c.enemy_spawn("lobo_mata_3", "lobo", -102.0, 128.0, 0.0, [(-102.0, 128.0), (-107.0, 121.0), (-93.0, 131.0)], leash=16.0)
    c.enemy_spawn("esqueleto_mata_1", "esqueleto", -34.0, 131.0, 0.0, [(-34.0, 131.0), (-29.0, 128.0), (-27.0, 136.0)])
    c.enemy_spawn("esqueleto_mata_2", "esqueleto", -88.0, 132.0, 0.0, [(-88.0, 132.0), (-95.0, 137.0), (-80.0, 136.0)])
    # Ruínas do Marco Antigo: o Guardião Rúnico (elite) ronda o lado oeste, fora do anel do monólito
    c.enemy_spawn("guardiao_ruinas", "guardiao", -89.0, 154.0, PI / 2, [(-89.0, 146.0), (-90.0, 162.0)], leash=12.0)

    # Fauna viva (não hostil): circula pelos laços e foge do jogador
    c.fauna("veado_mata_1", "pets/animal-deer", [(-46.0, 92.0), (-48.0, 86.0), (-40.0, 86.0), (-38.0, 94.0)], altura=1.3, velocidade=1.1, fuga=10.0)
    c.fauna("veado_mata_2", "pets/animal-deer", [(-92.0, 106.0), (-104.0, 108.0), (-100.0, 116.0), (-90.0, 114.0)], altura=1.25, velocidade=1.0, fuga=10.0)
    c.fauna("raposa_mata_1", "pets/animal-fox", [(-88.0, 96.0), (-80.0, 92.0), (-76.0, 100.0), (-86.0, 104.0)], altura=0.75, velocidade=1.6, fuga=8.0)
    c.fauna("raposa_ruinas_1", "pets/animal-fox", [(-30.0, 142.0), (-24.0, 152.0), (-36.0, 158.0)], altura=0.75, velocidade=1.6, fuga=8.0)
    c.fauna("coelho_mata_1", "pets/animal-bunny", [(-52.0, 122.0), (-56.0, 128.0), (-44.0, 130.0), (-42.0, 120.0)], altura=0.6, velocidade=1.4, fuga=6.0, salto=True)
    c.fauna("coelho_mata_2", "pets/animal-bunny", [(-30.0, 104.0), (-32.0, 96.0), (-26.0, 98.0)], altura=0.55, velocidade=1.4, fuga=6.0, salto=True)
    c.fauna("coelho_ribeirao_1", "pets/animal-bunny", [(100.0, 98.0), (108.0, 94.0), (112.0, 100.0)], altura=0.55, velocidade=1.4, fuga=6.0, salto=True)

    # Ponto de renascimento extramuros: junto à fogueira do acampamento, olhando para o fogo (a leste)
    c.respawn_point("acampamento", 40.4, 106.0, -PI / 2)


def _ambience(c) -> None:
    """Partículas ambientais: esporos azulados e vagalumes na Mata (mais fortes à noite), poeira dourada nas Ruínas."""
    c.particle_field("EsporosMata", "spores", -110.0, 76.0, -24.0, 135.0, count=240, color="#8fdcff",
                     y0=0.3, y1=3.4, size=0.11, night=0.7, speed=0.22)
    c.particle_field("VagalumesMata", "fireflies", -110.0, 76.0, -24.0, 135.0, count=90, color="#d4ff8a",
                     y0=0.4, y1=2.2, size=0.17, night=0.95, speed=0.5)
    c.particle_field("PoeiraRuinas", "dust", -96.0, 135.0, -40.0, 178.0, count=170, color="#ffd27a",
                     y0=0.2, y1=4.2, size=0.08, night=0.0, speed=0.12)
