"""
Mapa autoral de Cinzas de Alvor — capital murada da Marca de Alvor, com o Castelo de Alvor ao norte.
Coordenadas do Three.js em metros (x leste, z sul; norte = -z). K = 2.8 m por célula Kenney.

    N  Castelo de Alvor: muralha alta, portão com rastrilho de folha, pátio e o Paço do Marquês (z -156..-108)
       Campo do Castelo: estrada, moinho e pomar (oeste), estábulos e campo de treino (leste) (z -108..-66)
       ── Muralha Velha com o Portão Norte (z -66) ──
       Largo do Portão Norte, avenidas laterais da estalagem
       Estalagem Lanterna Torta + pátio (z -33..-14)
  O  Jardim / Templo  —  Praça do Marco (x/z -16..16)  —  Guilda / bairro leste  L
       Rua do Mercado: padaria, botica | forja, oficina do Darian
    S  Portão Sul (z 66)

A muralha externa fecha tudo: x -66..66, z -156..66.
Toda a geometria vem dos kits CC0 (Kenney Fantasy Town Kit 2.0, KayKit Dungeon/Forest/Adventurers).
"""
from __future__ import annotations

import math
import random
import sys
from pathlib import Path

try:
    from tools.zones import south_outskirts, urban_details
except ImportError:
    _tools_dir = str(Path(__file__).resolve().parent)
    if _tools_dir not in sys.path:
        sys.path.insert(0, _tools_dir)
    from zones import south_outskirts, urban_details

K = 2.8
KK = 0.8
PI = math.pi
FACE = {"S": 0.0, "N": PI, "E": PI / 2, "W": -PI / 2}   # modelos KayKit: frente em +Z local
FACE_VEC = {"S": (0.0, 1.0), "N": (0.0, -1.0), "E": (1.0, 0.0), "W": (-1.0, 0.0)}

WALL_X = 66.0          # muralha externa leste/oeste
WALL_S = 66.0          # muralha sul
WALL_N = -156.0        # muralha norte (fundo do castelo)
OLD_N = -66.0          # Muralha Velha (antigo limite norte da cidade)
CASTLE_X = 32.0        # muralha do castelo (meia largura)
CASTLE_FRONT = -108.0  # muralha frontal do castelo


def build(c) -> None:
    rng = random.Random(1912)
    c.bounds = {"minX": -150.0, "maxX": 150.0, "minZ": -200.0, "maxZ": 210.0}
    # Limite andável sincronizado com a planície extramuros (fonte única: south_outskirts.PLAIN). Ao norte da planície,
    # fora da muralha, o sopé perimetral de rochas fecha os corredores leste/oeste onde o relevo já sobe.
    plain = south_outskirts.PLAIN
    c.walk = {"minX": plain["minX"], "maxX": plain["maxX"], "minZ": WALL_N + 1.5, "maxZ": plain["maxZ"]}
    c.terrain = {"minX": -WALL_X - 3.0, "maxX": WALL_X + 3.0, "minZ": WALL_N - 3.0, "maxZ": WALL_S + 3.0, "cx": 0.0, "cz": 5.0, "size": 460.0}
    c.spawn = {"x": 0.0, "z": -9.0, "yaw": 0.0}
    # Enfermaria do Templo: onde o jogador acorda depois de uma derrota na cidade (olhando para a Praça, a leste)
    c.respawn_point("cidade", -10.2, 2.8, -PI / 2)

    def kk(name, x, z, face="S", s=KK, y=0.0, collide=None, pad=0.0, tag="", r=None, kit="dungeon", hinge=None):
        rot = FACE[face] if r is None else r
        return c.place(kit, name, x, y, z, rot, s, tag=tag, collide=collide, pad=pad, hinge=hinge)

    def seat(key, x, z, face, label="Sentar no banco", reach=1.6):
        fx, fz = FACE_VEC[face]
        c.interactable(key, "seat", x, z, label, reach=reach, look=[round(x + fx * 3.0, 3), round(z + fz * 3.0, 3)], seatY=0.0)

    def bench(key, x, z, face, s=KK):
        kk("bench", x, z, face, s=s, collide=f"Col_{key}")
        seat(f"banco_{key}", x, z, face)

    def brazier(key, x, z, light=True):
        kk("column", x, z, s=0.9, collide=f"Col_Brazier_{key}")
        kk("torch_lit", x, z, y=1.3, s=1.2)
        c.glows.append({"key": f"Brazier_{key}", "p": [x, 2.45, z], "color": "#ffb04a", "size": 1.4})
        if light:
            c.light(f"Braseiro_{key}", x, 2.2, z, "#ffb45a", 8.0, 11.0, flicker=0.16, importance=1.1, pool=3.6, glow=0.0)

    def banner_pole(key, x, z, face, banner="banner_patternA_red"):
        kk("post", x, z, face, s=[0.45, 0.85, 0.45], collide=f"Col_Pole_{key}")
        fx, fz = FACE_VEC[face]
        kk(banner, x + fx * 0.2, z + fz * 0.2, face, y=1.7, s=0.55)

    def chest(key, x, z, face, gold=False, label="Abrir o baú"):
        kk("chest_gold" if gold else "chest", x, z, face, s=0.6, collide=f"Col_Chest_{key}",
           hinge={"key": f"bau_{key}", "node": "chest_gold_lid" if gold else "chest_lid", "axis": "x", "angle": -1.2, "dur": 0.7, "open": False})
        c.interactable(f"bau_{key}", "chest", x, z, label, reach=1.7, hinge=f"bau_{key}")

    # ------------------------------------------------------------------ ruas
    c.street(-16, -12, 16, 12)            # Praça do Marco
    c.street(-6.5, 12, 6.5, 66)           # Rua do Mercado até o Portão Sul
    c.street(-13.2, -48, -7.4, -12)       # avenida oeste da estalagem
    c.street(7.4, -48, 13.2, -12)         # avenida leste
    c.street(-16, -66, 16, -44)           # Largo do Portão Norte
    c.street(16, -12.6, 64, -8.0)         # Rua da Guilda (leste)
    c.street(16, 8.4, 64, 13.0)           # Rua dos Ferreiros
    c.street(-64, -12.6, -16, -8.0)       # Rua do Templo
    c.street(-64, 8.4, -16, 13.0)         # Rua do Poço
    c.street(-34, -14, -28, -8)           # entrada do jardim
    c.street(-33.0, 13, -29.8, 32)        # beco do poço
    c.street(-3.6, -108, 3.6, -66)        # Estrada do Castelo
    c.street(-60, -88.6, 60, -84.0)       # Caminho dos Moinhos (atravessa o campo)
    c.street(-28, -137, 28, -110)         # pátio do castelo (lajeado)

    # ------------------------------------------------------------------ Estalagem Lanterna Torta
    c.building("Inn", -7.0, -25.2, 5, 4, floors=2, ridge="x", pal="creme_vermelho", interior=True, style="timber",
               doors=[(0.0, -14.0), (2.8, -25.2)], chimney=(0, 1), room="taverna",
               title="Estalagem Lanterna Torta", sub="Salão Aquecido · Lareira & Balcão")
    c.place("kenney", "banner-red", 4.2, K, -15.4, -PI / 2, K, pal="creme_vermelho", tag="inn_sign")
    for x in (-2.4, -0.8, 0.8, 2.4):
        kk("bar_straight_A", x, -20.6, "S", collide="Col_Inn_Counter")
    for k, x in enumerate((-2.4, -0.8, 0.8)):
        kk("stool_round", x, -19.45, "S", tag="seat")
        seat(f"banqueta_{k}", x, -19.45, "N", label="Sentar no balcão", reach=1.2)
    kk("stool_round", 2.4, -19.45, "S", tag="luna_stool")
    kk("shelves_decorated", -1.0, -25.05, "S", collide="Col_Inn_Shelves_O")
    kk("shelves_decorated", 1.0, -25.05, "S", collide="Col_Inn_Shelves_L")
    kk("keg_decorated", 5.0, -23.9, "W", s=0.62, collide="Col_Inn_Kegs")
    kk("barrel_large", -5.7, -24.1, s=0.5, collide="Col_Inn_Barrel")
    kk("barrel_large", -4.7, -24.3, s=0.45, collide="Col_Inn_Barrel")
    kk("barrel_small_stack", -6.2, -22.4, "E", s=0.55, collide="Col_Inn_Barrels2")
    kk("mug_full", -1.9, -20.6, y=0.8, s=0.55, kit="adv")
    kk("mug_full", 0.4, -20.5, y=0.8, s=0.55, kit="adv")
    kk("plate_food_A", 1.4, -20.6, y=0.79, s=0.5)
    kk("candle_triple", -0.4, -20.7, y=0.79, s=0.6)
    for name, (tx, tz) in (("O", (-3.8, -16.6)), ("L", (3.8, -16.6))):
        kk("table_medium_decorated_A", tx, tz, collide=f"Col_Inn_Table_{name}", pad=-0.05)
        kk("chair", tx, tz + 1.15, "N", tag="seat")
        kk("chair", tx - 1.15, tz, "E", tag="seat")
        kk("chair", tx + 1.15, tz, "W", tag="seat")
        seat(f"cadeira_{name}_o", tx - 1.15, tz, "E", label="Sentar à mesa", reach=1.2)
        seat(f"cadeira_{name}_l", tx + 1.15, tz, "W", label="Sentar à mesa", reach=1.2)
    # Lareira de pedra (arco do kit de masmorra) na parede oeste
    kk("wall_arched", -6.75, -18.6, "E", s=0.5, collide="Col_Inn_Hearth")
    kk("trunk_medium_A", -6.35, -18.6, "E", s=0.55, tag="hearth_logs", collide="Col_Inn_Logs")
    c.anchor("Hearth", -6.35, 0.35, -18.6, fire="hearth", size=1.0)
    c.interactable("lareira_inn", "hearth", -5.4, -18.6, "Aquecer as mãos", reach=1.9)
    c.light("Fireplace", -6.0, 0.9, -18.6, "#ff7a2a", 14.0, 13.0, flicker=0.32, zone="Inn", importance=3.0, glow=0.0)
    c.light("InnCounter", 0.0, 2.25, -20.3, "#ffbe74", 6.0, 9.0, flicker=0.04, zone="Inn", importance=2.0, glow=0.9)
    kk("candle_lit", 3.8, -16.6, y=0.8, s=0.5)
    kk("candle_lit", -3.8, -16.6, y=0.8, s=0.5)
    kk("torch_mounted", 6.75, -18.6, "W", y=1.7, s=0.7)
    kk("torch_mounted", -6.75, -22.8, "E", y=1.7, s=0.7)
    kk("banner_patternA_red", -2.0, -25.05, "S", y=0.6, s=0.45)
    # Detalhes do salão: prateleira de garrafas, troféu na parede, caixotes de mantimentos
    kk("shelf_small_candles", 6.75, -21.8, "W", y=1.3, s=0.6)
    kk("sword_shield", 6.8, -16.0, "W", y=1.25, s=0.5)
    kk("crates_stacked", -6.2, -15.0, s=0.45, collide="Col_Inn_Crates")
    kk("bottle_A_labeled_brown", -2.6, -20.65, y=0.8, s=0.5)
    kk("bottle_B_green", 2.0, -20.7, y=0.8, s=0.5)
    c.anchor("Counter", 0.8, 0.0, -18.9, look=[0.6, 1.3, -21.6])
    # Pátio dos fundos: cerca (módulos de borda posicionados pelo centro do painel), lenha, cepo com machado
    for k in range(3):
        z = -26.6 - k * K
        c.place_centered("kenney", "fence", 0.0, 0.0, z, PI, K, tag="yard_fence", collide=f"Col_Yard_W{k}")
        c.place_centered("kenney", "fence", 7.0, 0.0, z, 0.0, K, tag="yard_fence", collide=f"Col_Yard_E{k}")
        c.place_centered("kenney", "fence", 0.0 + (k + 0.5) * (7.0 / 3), 0.0, -33.4, PI / 2, [K, K, 7.0 / 3], tag="yard_fence", collide=f"Col_Yard_N{k}")
    for k, (x, z) in enumerate(((1.1, -32.2), (2.3, -32.3), (3.5, -32.2), (1.7, -32.2), (2.9, -32.25))):
        kk("trunk_large_A", x, z, "E", s=0.62, y=0.0 if k < 3 else 0.6, collide=f"Col_Woodpile_{k}" if k < 3 else None)
    kk("trunk_large_A", 2.3, -32.25, "E", s=0.62, y=1.2)
    kk("trunk_medium_A", 5.0, -29.6, collide="Col_ChoppingBlock")
    kk("axe_1handed", 5.05, -29.6, y=0.62, s=0.7, r=0.4, kit="adv")
    kk("crates_stacked", 5.9, -32.4, s=0.5, collide="Col_Yard_Crates")
    c.collectible("lenha_patio", 2.6, -29.4, [
        {"kit": "dungeon", "name": "trunk_small_A", "x": 2.45, "z": -29.4, "y": 0.0, "r": 0.2, "s": 0.55},
        {"kit": "dungeon", "name": "trunk_small_A", "x": 2.8, "z": -29.35, "y": 0.0, "r": -0.15, "s": 0.55},
        {"kit": "dungeon", "name": "trunk_small_A", "x": 2.62, "z": -29.4, "y": 0.26, "r": 0.05, "s": 0.55},
    ], reach=1.5)
    kk("torch_mounted", 4.6, -25.55, "N", y=1.9, s=0.7)
    c.light("Backyard", 4.6, 2.3, -26.2, "#ffa64d", 5.5, 10.0, flicker=0.08, zone="Backyard", importance=1.6, pool=3.5, glow=1.0)
    c.zone("Backyard", 0.25, -33.3, 6.8, -25.4, "Fundos da Lanterna Torta", "Área de Serviço · Lenha, Cepo & Machado", priority=3)

    # ------------------------------------------------------------------ Praça do Marco
    # Centro: chafariz redondo com o Marco no meio; o Cristal de Mana flutua acima e ilumina a praça
    c.place("kenney", "fountain-round", 0.0, 0.0, 0.0, 0.0, 2.7, pal="pedra", tag="fountain", collide="Col_Fonte_Praca")
    kk("pillar_decorated", 0.0, 0.0, s=0.62)
    c.anchor("ManaCrystal", 0.0, 3.4, 0.0, crystal=1)
    c.light("ManaCrystal", 0.0, 3.8, 0.0, "#46d2ff", 16.0, 24.0, flicker=0.1, importance=2.6, glow=2.8, pool=8.0)
    c.interactable("fonte_praca", "drink", 0.0, 2.95, "Beber da fonte do Marco", reach=1.6, restore={"vigor": 20, "calor": 0})
    c.zone("Praca", -16, -12, 16, 12, "Praça do Marco", "Coração de Cinzas de Alvor · Cristal de Mana", priority=1, marco="Praca")
    for k, (x, z, face) in enumerate(((-5.4, 0.0, "E"), (5.4, 0.0, "W"), (0.0, -5.4, "S"), (0.0, 5.4, "N"))):
        bench(f"Plaza_Bench_{k}", x, z, face)
    # Iluminação: oito lampiões no contorno + quatro braseiros nas diagonais do chafariz
    for name, (x, z) in (("ne", (13.6, -9.8)), ("no", (-13.6, -9.8)), ("se", (13.6, 7.2)), ("so", (-13.6, 7.2)),
                         ("n_l", (4.6, -10.8)), ("s_l", (4.4, 10.2)), ("s_o", (-4.4, 10.2)), ("l", (14.4, 4.6))):
        c.lamp(f"praca_{name}", x, z)
    for k, (x, z) in enumerate(((-6.2, -6.2), (6.2, -6.2), (-6.2, 6.2), (6.2, 6.2))):
        brazier(f"praca_{k}", x, z, light=k in (0, 3))
    for k, (x, z, model) in enumerate(((-15.6, -6.8, "Tree_1_A_Color1"), (14.2, -2.5, "Tree_3_A_Color1"), (-7.5, -10.6, "Tree_5_A_Color1"), (7.5, -10.6, "Tree_4_A_Color1"))):
        c.tree(model, x, z, s=1.15, r=rng.uniform(0, PI * 2))
        for j in range(5):
            a = j * 1.26 + rng.uniform(-0.2, 0.2)
            c.place("forest", rng.choice(["Bush_1_A_Color1", "Bush_2_A_Color1", "Grass_1_A_Color1"]), x + math.cos(a) * 1.2, 0.0, z + math.sin(a) * 1.2,
                    rng.uniform(0, 6.28), rng.uniform(1.0, 1.5), tag="bush", cast=False)
    # Mercado: barracas na borda sul (frutas, pães, tecidos) e duas na borda norte, com mercadoria e caixotes
    for k, (x, model) in enumerate(((-12.0, "stall-red"), (-8.6, "stall-green"), (8.6, "stall-red"), (12.0, "stall-green"))):
        c.place("kenney", model, x, 0.0, 10.6, PI / 2, 2.1, pal="base", tag="stall", collide=f"Col_Stall_{k}", pad=-0.1)
    for k, (x, n) in enumerate(((-12.0, "plate_food_A"), (-8.6, "plate_food_B"), (8.6, "bottle_A_green"), (12.0, "coin_stack_small"))):
        kk(n, x, 10.0, y=0.92, s=0.45)
    for k, (x, z) in enumerate(((-12.4, -5.4), (12.4, -5.4))):
        c.place("kenney", "stall-red" if k else "stall-green", x, 0.0, z, -PI / 2 if k else PI / 2, 2.0, pal="base", tag="stall",
                collide=f"Col_StallN_{k}", pad=-0.1)
        kk("plate_food_A" if k else "bottle_B_brown", x, z, y=0.88, s=0.45)
    for k, (x, z, n, s) in enumerate(((-10.2, 11.6, "crates_stacked", 0.45), (10.3, 11.7, "barrel_small_stack", 0.5), (-14.2, -7.4, "box_stacked", 0.45),
                                      (14.4, -7.3, "barrel_large", 0.42), (-6.8, 11.4, "crate_small", 0.6), (6.9, 11.5, "keg", 0.55))):
        kk(n, x, z, s=s, collide=f"Col_Market_{k}")
    c.place("kenney", "cart-high", -13.6, 0.0, 2.6, 0.5, 2.0, pal="base", tag="cart", collide="Col_Cart", pad=-0.05)
    c.collectible("maca_carroca", -12.0, 4.6, [{"kit": "dungeon", "name": "bucket", "x": -12.0, "z": 4.6, "s": 0.45}], reach=1.4)
    banner_pole("praca_o", -2.6, -11.2, "S", "banner_patternA_red")
    banner_pole("praca_l", 2.6, -11.2, "S", "banner_patternA_blue")
    # Mural da praça (tábua sobre dois postes)
    c.place("kenney", "wall-wood", -4.6, 0.75, -10.6, PI / 2, [1.0, 0.55, 0.9], pal="base", tag="sign", collide="Col_Mural")
    for x in (-5.8, -3.4):
        kk("post", x, -10.85, s=[0.3, 0.42, 0.3], collide=f"Col_Mural_{x}")
    c.interactable("mural_praca", "sign", -4.6, -9.8, "Ler o mural da praça", reach=1.8, title="Mural da Praça do Marco",
                   text="Por ordem do Marquês de Alvor: o Portão Sul fecha ao anoitecer. Quem avistar lobos na Mata Cinzenta, "
                        "avise a guarda. — Procura-se: gato laranja atende por Bolinho (falar com Tilly). — A Guilda paga em "
                        "cobre por ervas-de-brasa entregues na Botica. — O Castelo abre o pátio aos cidadãos até o toque do sino.")

    # ------------------------------------------------------------------ Guilda dos Aventureiros
    c.building("Guilda", 18.0, -5.6, 5, 4, floors=3, ridge="x", pal="branco_azul", interior=True, style="timber",
               doors=[(18.0, -1.4), (18.0, 1.4)], chimney=(4, 0), room="guilda",
               title="Guilda dos Aventureiros", sub="Recepção da Maren · Quadro de Contratos")
    c.tower("GuildaTorreN", 32.0, -5.6, 5, pal="branco_azul")
    c.tower("GuildaTorreS", 32.0, 2.8, 5, pal="branco_azul")
    for z in (-4.2, 4.2):
        c.place("kenney", "banner-green", 18.0 + 0.5 * K, K, z, PI, K, pal="branco_azul", tag="guild_banner")
    for z in (-1.6, 0.0, 1.6):
        kk("bar_straight_A", 28.6, z, "W", collide="Col_Guild_Counter")
    kk("bookcase_double_decoratedA", 31.75, 0.0, "W", s=0.62)
    kk("banner_shield_blue", 24.0, -5.35, "S", y=0.3, s=0.6)
    c.place("kenney", "wall-wood", 24.0, 0.7, -4.85, PI / 2, [1.0, 1.25, 2.4], pal="branco_azul", tag="quest_board")
    for k, x in enumerate((23.1, 23.6, 24.4, 24.9)):
        kk("book_tan", x, -5.22, "S", y=1.25 + (k % 2) * 0.35, s=0.4, r=PI / 2)
    c.interactable("quadro_guilda", "board", 24.0, -3.9, "Ler o Quadro de Contratos", reach=2.0)
    kk("table_long_decorated_A", 22.8, 2.6, r=PI / 2, collide="Col_Guild_Table", pad=-0.05)
    kk("bench", 22.8, 1.35, "S", collide="Col_Guild_Bench_N")
    kk("bench", 22.8, 3.85, "N", collide="Col_Guild_Bench_S")
    seat("banco_guilda_n", 22.8, 1.0, "S", label="Sentar à mesa comprida", reach=1.4)
    seat("banco_guilda_s", 22.8, 4.2, "N", label="Sentar à mesa comprida", reach=1.4)
    kk("coin_stack_large", 28.6, 1.6, y=0.8, s=0.3)
    kk("candle_lit", 28.6, -1.2, y=0.8, s=0.5)
    # Lareira na parede sul (atrás do balcão), troféus, baú da guilda e mesa redonda dos veteranos
    kk("wall_arched", 30.4, 5.25, "N", s=0.5, collide="Col_Guild_Hearth")
    kk("trunk_medium_A", 30.4, 4.85, "N", s=0.5, collide="Col_Guild_Logs")
    c.anchor("GuildHearth", 30.4, 0.35, 4.8, fire="hearth", size=0.9)
    c.light("GuildaLareira", 30.4, 0.9, 4.4, "#ff7a2a", 9.0, 10.0, flicker=0.3, zone="Guilda", importance=2.4, glow=0.0)
    c.interactable("lareira_guilda", "hearth", 30.0, 3.7, "Aquecer as mãos", reach=1.8)
    for k, x in enumerate((19.8, 21.6)):
        kk("sword_shield", x, -5.3, "S", y=1.25, s=0.5)
    kk("banner_patternB_blue", 26.4, -5.3, "S", y=0.6, s=0.45)
    kk("shelf_small_books", 19.0, 5.3, "N", y=1.2, s=0.6)
    chest("guilda", 19.4, -4.5, "S", label="Abrir o baú de achados da Guilda")
    kk("table_round_medium", 25.6, 3.4, s=0.6, collide="Col_Guild_RoundTable")
    for k, (dx, dz, face) in enumerate(((-1.1, 0.0, "E"), (1.1, 0.0, "W"), (0.0, -1.1, "S"))):
        kk("chair", 25.6 + dx, 3.4 + dz, face, tag="seat")
        seat(f"cadeira_guilda_{k}", 25.6 + dx, 3.4 + dz, face, label="Sentar à mesa redonda", reach=1.1)
    kk("candle_thin_lit", 25.6, 3.4, y=0.62, s=0.5)
    c.light("Guilda", 24.5, 2.5, 0.0, "#ffd29a", 8.0, 12.0, flicker=0.03, zone="Guilda", importance=2.2, glow=1.0)
    c.light("GuildaPorta", 16.9, 2.7, 0.0, "#ffb15c", 4.5, 9.0, flicker=0.05, importance=1.0, pool=3.6, glow=1.2)
    c.zone("GuildaMarco", 14.0, -7.0, 32.0, 7.0, "Guilda dos Aventureiros", "Recepção da Maren · Quadro de Contratos", priority=0, marco="Guilda")

    # ------------------------------------------------------------------ Catedral de Aurélia + Jardim
    # Nave de 11 x 4 células (30,8 x 11,2 m) com pé-direito de 11,2 m e rosáceas nos andares altos; fachada a leste
    # com duas torres esbeltas (28 m + coruchéu) e o pórtico recuado entre elas; torre-lanterna no cruzeiro (sobre o
    # telhado) e abside a oeste. A chave 'Templo' continua (zonas, marco das missões, áudio de interior).
    cat_x0, cat_x1 = -49.6, -18.8
    c.building("Templo", cat_x0, -5.6, 11, 4, floors=4, ridge="x", pal="branco_dourado", style="plaster", room="templo",
               interior=True, mezzanine=False, door_open=True, doors=[(cat_x1, -1.4), (cat_x1, 1.4)],
               window="wall", upper_window="wall-window-round", window_floors=(2,),
               title="Catedral de Aurélia", sub="Templo da Deusa da Aurora · Bênçãos aos Despertos")
    for key, z0 in (("CatedralTorreN", -5.6), ("CatedralTorreS", 2.8)):
        c.tower(key, cat_x1, z0, 10, pal="branco_dourado", spire=3.0)
    c.big_tower("CatedralCruzeiro", -34.8, -2.8, cells=2, floors=3, pal="branco_dourado", spire=2.6, y0=4 * 2.8)
    c.big_tower("CatedralAbside", cat_x0 - 5.6, -2.8, cells=2, floors=3, pal="branco_dourado", spire=1.8)
    # Rosácea da fachada: módulo de janela redonda em escala 2x entre as torres (andares 1-2), 6 cm à frente da parede
    # (o painel do módulo fica na borda +X da célula: centro = parede - meia célula escalada)
    c.place("kenney", "wall-window-round", cat_x1 + 0.06 - 2.8, 2.8, 0.0, 0.0, 2.8 * 2, pal="branco_dourado", tag="b:Templo")
    # Interior: colunata da nave, bancos voltados para o altar, altar com velas, estandartes e luz quente
    for k, x in enumerate((-44.0, -38.4, -32.8, -27.2, -21.6)):
        for z in (-3.9, 3.9):
            kk("pillar", x, z, s=[0.34, 2.6, 0.34], collide=f"Col_Coluna_Nave_{k}_{z}", pad=0.02)
    for k, x in enumerate((-23.0, -25.4, -27.8, -30.2, -32.6, -35.0)):
        for z in (-2.2, 2.2):
            kk("bench", x, z, "W", s=[1.0, 0.9, 0.9], tag="seat", collide=f"Col_Banco_Nave_{k}_{z}", pad=-0.05)
    for z in (-2.2, 2.2):
        seat(f"banco_catedral_{'n' if z < 0 else 's'}", -23.0, z, "W", label="Sentar no banco da catedral", reach=1.3)
    kk("table_long_tablecloth_decorated_A", -45.6, 0.0, r=0.0, s=[0.55, 0.62, 0.7], collide="Col_Altar", pad=-0.05)
    for z in (-1.0, 0.0, 1.0):
        kk("candle_triple", -45.6, z, y=1.17, s=0.6)
    for k, (z, name) in enumerate(((-3.6, "banner_patternA_yellow"), (0.0, "banner_triple_white"), (3.6, "banner_patternA_yellow"))):
        kk(name, cat_x0 + 0.35, z, "E", y=2.4 if k != 1 else 3.6, s=1.1 if k != 1 else 1.4)
    for k, x in enumerate((-40.6, -29.4)):
        for z in (-5.2, 5.2):
            kk("banner_thin_white", x, z, "S" if z < 0 else "N", y=4.2, s=1.0)
    for k, (x, z) in enumerate(((-43.6, -2.6), (-43.6, 2.6))):
        kk("candle_triple", x, z, s=0.9, collide=f"Col_Vela_Altar_{k}")
    c.light("CatedralAltar", -45.0, 3.2, 0.0, "#ffd9a0", 9.0, 14.0, flicker=0.06, zone="Templo", importance=2.6, glow=0.0)
    c.light("CatedralNave", -32.0, 5.0, 0.0, "#ffe9c8", 8.0, 18.0, flicker=0.03, zone="Templo", importance=2.2, glow=0.0)
    c.light("CatedralEntrada", -21.6, 3.4, 0.0, "#ffd29a", 6.0, 11.0, flicker=0.04, zone="Templo", importance=1.6, glow=0.0)
    # Pórtico: braseiros diante da fachada e o sino de Aurélia entre as torres
    for z in (-3.6, 3.6):
        kk("column", -14.8, z, s=0.9, collide=f"Col_Brazier_{z}")
        kk("torch_lit", -14.8, z, y=1.3, s=1.2)
    c.light("TemploBraseiros", -14.8, 2.0, 0.0, "#ffcf6a", 6.5, 11.0, flicker=0.16, importance=1.3, pool=4.0, glow=0.0)
    for z in (-3.6, 3.6):
        c.glows.append({"key": f"Brazier_{z}", "p": [-14.8, 2.45, z], "color": "#ffb04a", "size": 1.4})
    c.interactable("sino_templo", "bell", -17.2, 0.0, "Tocar o sino de Aurélia", reach=1.8)
    c.zone("TemploMarco", -62.0, -8.0, -14.0, 8.0, "Catedral de Aurélia", "Templo da Deusa da Aurora · Bênçãos aos Despertos", priority=0, marco="Templo")
    # Jardim (cercado de sebes, chafariz, ervas): sebes posicionadas pelo centro do painel, colisor pela pegada real
    jx0, jz0, jx1, jz1 = -42.0, -32.0, -20.0, -14.0
    hs = [2.0, 2.0, 2.0]
    for x in range(int(jx0) + 1, int(jx1), 2):
        if abs(x + 31) >= 2.2:
            c.place_centered("kenney", "hedge-large", x + 0.5, 0.0, jz1, -PI / 2, hs, pal="base", tag="hedge", collide=f"Col_Hedge_S{x}")
        c.place_centered("kenney", "hedge-large", x + 0.5, 0.0, jz0, PI / 2, hs, pal="base", tag="hedge", collide=f"Col_Hedge_N{x}")
    for z in range(int(jz0) + 1, int(jz1), 2):
        c.place_centered("kenney", "hedge-large", jx0, 0.0, z + 0.5, PI, hs, pal="base", tag="hedge", collide=f"Col_Hedge_W{z}")
        c.place_centered("kenney", "hedge-large", jx1, 0.0, z + 0.5, 0.0, hs, pal="base", tag="hedge", collide=f"Col_Hedge_E{z}")
    c.place("kenney", "fountain-round-detail", -31.0, 0.0, -23.0, 0.0, 2.3, pal="base", tag="fountain", collide="Col_Fountain", pad=-0.15)
    c.interactable("fonte_jardim", "drink", -31.0, -20.4, "Beber do chafariz de Aurélia", reach=1.6, restore={"vigor": 15, "calor": 0})
    c.light("Fonte", -31.0, 2.4, -23.0, "#9fd8ff", 2.5, 8.0, flicker=0.02, importance=0.6, pool=3.0, glow=0.0)
    for k, (x, z, face) in enumerate(((-25.6, -23.6, "W"), (-36.4, -23.6, "E"))):
        bench(f"Garden_Bench_{k}", x, z, face)
    for k, (x, z) in enumerate(((-39.0, -16.6), (-39.2, -29.4), (-22.6, -29.6), (-36.0, -27.8), (-26.0, -17.0))):
        c.tree(["Tree_2_A_Color1", "Tree_6_A_Color1", "Tree_7_A_Color1", "Tree_3_A_Color1", "Tree_1_A_Color1"][k], x, z, s=1.05, r=rng.uniform(0, 6.28))
    for k in range(26):
        x, z = rng.uniform(jx0 + 1.5, jx1 - 1.5), rng.uniform(jz0 + 1.5, jz1 - 1.5)
        if math.hypot(x + 31, z + 23) < 3.4 or abs(x + 31) < 1.6:
            continue
        c.place("forest", rng.choice(["Bush_1_A_Color1", "Bush_2_A_Color1", "Bush_3_A_Color1", "Bush_4_A_Color1", "Grass_1_A_Color1"]),
                x, 0.0, z, rng.uniform(0, 6.28), rng.uniform(1.6, 2.4), tag="bush", cast=False)
    for key, (x, z) in (("erva_1", (-37.2, -17.6)), ("erva_2", (-38.0, -26.4)), ("erva_3", (-24.0, -28.0)), ("erva_4", (-24.4, -17.4))):
        c.collectible(key, x, z, [{"kit": "forest", "name": "Bush_4_A_Color1", "x": x, "z": z, "s": 1.5}], reach=1.3)
        c.glows.append({"key": f"Erva_{key}", "p": [x, 0.55, z], "color": "#ff6a2a", "size": 0.9, "collect": key})
    c.zone("Jardim", jx0, jz0, jx1, jz1, "Jardim do Templo", "Chafariz de Aurélia · Ervas & Flores", priority=1, marco="Jardim")

    # ------------------------------------------------------------------ Rua do Mercado
    shops = [
        ("Padaria", -17.7, 16.0, 3, "creme_laranja", "E", "Padaria da Rosa", "Pão Quentinho · Pãezinhos de Mel", "padaria"),
        ("Botica", -17.7, 28.0, 3, "creme_verde", "E", "Botica da Sera", "Chás, Poções & Ingredientes Raros", "botica"),
        ("CasaM1", -17.7, 40.0, 2, "ocre_azul", "E", "", "", "casa"),
        ("CasaM2", -17.7, 49.6, 2, "creme_vermelho", "E", "", "", "casa"),
        ("Oficina", 6.5, 28.0, 3, "creme_roxo", "W", "Oficina do Velho Darian", "Relógios, Lentes & Relíquias", "oficina"),
        ("CasaM3", 6.5, 40.0, 2, "creme_azul", "W", "", "", "casa"),
        ("CasaM4", 6.5, 49.6, 2, "ocre_vermelho", "W", "", "", "casa"),
    ]
    for key, x0, z0, d, pal, side, title, sub, room in shops:
        door_x = x0 + 4 * K if side == "E" else x0
        c.building(key, x0, z0, 4, d, floors=2, ridge="z", pal=pal, style="timber" if key != "Padaria" else "plaster", window="wall-window-shutters",
                   doors=[(door_x, z0 + d * K * 0.5)], title=title, sub=sub, room=room, awning=True, plinth="pedra_escura",
                   timber_pattern=("wall-detail-cross", "wall-detail-diagonal")[zlib_mix(key) % 2],
                   chimney=(1, 0) if key in ("Padaria", "Oficina") else None)
    # Forja: oficina recuada com pátio aberto para a rua
    c.building("Forja", 10.7, 16.0, 4, 3, floors=1, ridge="z", pal="pedra_escura", style="wood", doors=[(10.7, 23.0)], room="forja",
               chimney=(1, 1), title="Forja do Torvin", sub="Ferro, Fogo & Resmungos")
    for z in (16.6, 23.8):
        c.place("kenney", "pillar-wood", 7.0, 0.0, z, 0.0, [2.0, 2.6, 2.0], pal="pedra_escura", tag="forge_post", collide=f"Col_Forge_Post_{z}")
    for k in range(3):
        c.place("kenney", "roof-flat", 8.6, 2.6, 17.4 + k * 2.4, 0.0, [3.8, 1.2, 2.4], pal="pedra_escura", tag="forge_awning")
    c.roof("ForjaPatio", 6.6, 16.0, 10.8, 24.4)
    c.place("kenney", "chimney-base", 9.4, 0.0, 22.8, PI, [3.2, 1.0, 3.2], pal="pedra_escura", tag="forge_hearth", collide="Col_Forge_Hearth", pad=0.0)
    c.anchor("Forge", 9.9, 0.95, 22.8, fire="forge", size=0.8)
    c.interactable("forja_fogo", "hearth", 8.4, 21.8, "Aquecer as mãos na forja", reach=1.6)
    c.light("Forja", 9.6, 1.4, 22.6, "#ff6a1f", 9.0, 11.0, flicker=0.28, importance=1.8, pool=3.5, glow=0.0)
    kk("column", 7.9, 19.6, s=[0.55, 0.42, 0.35], collide="Col_Anvil")
    kk("sword_shield", 7.9, 19.6, y=0.62, s=0.35, r=PI / 2)
    kk("barrel_large", 10.1, 17.0, s=0.45, collide="Col_Forge_Barrel")
    kk("box_stacked", 21.0, 26.6, s=0.45, collide="Col_Alley_Boxes")
    kk("crates_stacked", 23.0, 26.2, s=0.5, collide="Col_Alley_Crates")
    c.zone("ForjaPatioZ", 6.5, 16.0, 10.7, 24.4, "Forja do Torvin", "Ferro, Fogo & Resmungos", priority=2)
    c.place("kenney", "stall-red", -5.2, 0.0, 23.0, -PI / 2, 2.0, pal="base", tag="stall", collide="Col_Stall_Padaria", pad=-0.1)
    kk("plate_food_B", -5.2, 23.0, y=0.65, s=0.45)
    kk("box_small_decorated", -5.6, 18.0, s=0.5, collide="Col_Padaria_Box")
    c.place("kenney", "stall-green", -5.2, 0.0, 35.0, -PI / 2, 2.0, pal="base", tag="stall", collide="Col_Stall_Botica", pad=-0.1)
    for k, n in enumerate(("bottle_A_green", "bottle_B_brown", "bottle_C_green", "bottle_A_labeled_green")):
        kk(n, -5.0, 34.4 + k * 0.4, y=0.65, s=0.45)
    c.place("kenney", "stall", 5.3, 0.0, 34.6, PI / 2, 2.0, pal="base", tag="stall", collide="Col_Stall_Darian", pad=-0.05)
    kk("coin_stack_medium", 5.3, 34.6, y=0.72, s=0.35)
    kk("candle_thin_lit", 5.3, 35.4, y=0.72, s=0.45)
    for name, (x, z) in (("m1", (5.9, 14.4)), ("m2", (-5.9, 27.0)), ("m3", (5.9, 39.0)), ("m4", (-5.9, 47.5)), ("m5", (5.9, 56.0))):
        c.lamp(name, x, z)
    c.zone("Mercado", -6.5, 13.0, 6.5, 48.0, "Rua do Mercado", "Padaria · Botica · Forja · Oficina", priority=1, marco="Mercado")

    # ------------------------------------------------------------------ Muralha externa (fecha cidade e castelo)
    # Portão Sul: torres largas encostadas no vão do portão (igual ao Portão Norte, abre passagem para o sul)
    c.big_tower("PortaoTorreO", -9.1, WALL_S - 2.8, cells=2, floors=3, pal="pedra")
    c.big_tower("PortaoTorreL", 3.5, WALL_S - 2.8, cells=2, floors=3, pal="pedra")
    c.gate("portao_sul", 0.0, WALL_S, 0.0, sx=1.75, open_=True)
    c.interactable("sarilho_sul", "lever", -2.6, WALL_S - 1.9, "Girar o sarilho do Portão Sul", reach=1.6, gate="portao_sul")
    kk("torch_mounted", -2.8, WALL_S - 0.8, "N", y=2.2, s=0.8)
    kk("torch_mounted", 2.8, WALL_S - 0.8, "N", y=2.2, s=0.8)
    c.light("Portao", 0.0, 3.0, 61.6, "#ffa045", 7.0, 12.0, flicker=0.15, importance=1.2, pool=4.2, glow=1.3)
    kk("crates_stacked", -5.0, 58.6, s=0.45, collide="Col_Gate_Crates")
    c.zone("PortaoSul", -9.3, 52.0, 9.3, 63.0, "Portão Sul", "Estrada para a Mata Cinzenta · Fechado à Noite", priority=1, marco="PortaoSul")
    c.interactable("placa_portao_sul", "sign", -3.0, 61.2, "Ler a placa do portão", reach=1.6, title="Portão Sul",
                   text="Daqui parte a Estrada Velha para a Mata Cinzenta. Portão fechado do pôr ao nascer do sol. "
                        "Viajantes devem se apresentar ao Capitão Aldric.")
    corner = 2.8 * 2
    # Trechos da muralha entre torres (o vão é calculado: nenhum trecho fica sem pedra)
    c.wall_run("Muralha_S1", -WALL_X + corner * 0.5, WALL_S, -9.1, WALL_S)
    c.wall_run("Muralha_S2", 9.1, WALL_S, WALL_X - corner * 0.5, WALL_S)
    mids = (-110.0, OLD_N, -22.0, 22.0)
    for side, x in (("O", -WALL_X), ("L", WALL_X)):
        stops = [WALL_N + corner * 0.5] + [m for m in mids] + [WALL_S - corner * 0.5]
        for k, (a, b) in enumerate(zip(stops, stops[1:])):
            a2 = a + (1.4 if k > 0 else 0.0)
            b2 = b - (1.4 if k < len(stops) - 2 else 0.0)
            c.wall_run(f"Muralha_{side}{k}", x, a2, x, b2)
        for m in mids:
            c.tower(f"MuralhaTorre_{side}_{int(m)}", x - 1.4, m - 1.4, 3, pal="pedra")
    for x, z in ((-WALL_X, WALL_N), (WALL_X, WALL_N), (-WALL_X, WALL_S), (WALL_X, WALL_S)):
        c.big_tower(f"MuralhaCanto_{int(x)}_{int(z)}", x - corner * 0.5, z - corner * 0.5, cells=2, floors=3, pal="pedra")
    # Fundo (norte) fora do castelo
    c.wall_run("Muralha_N_O", -WALL_X + corner * 0.5, WALL_N, -CASTLE_X - corner * 0.5, WALL_N)
    c.wall_run("Muralha_N_L", CASTLE_X + corner * 0.5, WALL_N, WALL_X - corner * 0.5, WALL_N)

    # ------------------------------------------------------------------ Muralha Velha e Portão Norte
    c.big_tower("PortaoNorteO", -9.1, OLD_N - 2.8, cells=2, floors=3, pal="pedra")
    c.big_tower("PortaoNorteL", 3.5, OLD_N - 2.8, cells=2, floors=3, pal="pedra")
    c.gate("portao_norte", 0.0, OLD_N, 0.0, sx=1.75, open_=True)   # 4 x 1,75 = 7 m: encosta nas duas torres
    c.wall_run("MuralhaVelha_O", -WALL_X + 1.4, OLD_N, -9.1, OLD_N)
    c.wall_run("MuralhaVelha_L", 9.1, OLD_N, WALL_X - 1.4, OLD_N)
    c.interactable("sarilho_norte", "lever", -2.6, OLD_N + 1.9, "Girar o sarilho do Portão Norte", reach=1.6, gate="portao_norte")
    kk("torch_mounted", -3.0, OLD_N + 0.75, "S", y=2.4, s=0.8)
    kk("torch_mounted", 3.0, OLD_N + 0.75, "S", y=2.4, s=0.8)
    c.light("PortaoNorte", 0.0, 3.0, OLD_N + 2.4, "#ffa045", 7.0, 12.0, flicker=0.15, importance=1.2, pool=4.2, glow=1.3)
    c.zone("LargoNorte", -16.0, -66.0, 16.0, -44.0, "Largo do Portão Norte", "Muralha Velha · Caminho do Castelo", priority=1)
    for x in (-12.8, 12.8):
        c.lamp(f"largo_{x}", x, -50.0)
    c.place("kenney", "fountain-square", -9.0, 0.0, -55.0, 0.0, 1.3, pal="pedra", tag="well", collide="Col_Poco_Largo", pad=-0.1)
    kk("bucket", -8.0, -54.0, s=0.5)
    c.interactable("poco_largo", "drink", -9.0, -53.2, "Tirar água do poço", reach=1.5, restore={"vigor": 15, "calor": 0})
    for k, (x, z) in enumerate(((9.0, -56.0), (11.0, -57.5))):
        kk("barrel_large" if k else "crates_stacked", x, z, s=0.45, collide=f"Col_Largo_{k}")
    bench("Largo_Bench", 13.4, -58.0, "W")
    houses_north = [
        ("CasaN4", -30.0, -60.0, 4, 2, 2, "creme_azul", (-24.4, -54.4), "timber"),
        ("CasaN5", 18.0, -60.0, 4, 2, 2, "ocre_vermelho", (23.6, -54.4), "plaster"),
    ]

    # ------------------------------------------------------------------ Campo do Castelo (entre a Muralha Velha e o castelo)
    c.zone("CampoCastelo", -WALL_X, CASTLE_FRONT, WALL_X, OLD_N, "Campo do Castelo", "Moinho · Pomar · Estábulos · Campo de Treino", priority=0)
    for k, z in enumerate((-74.0, -96.0)):
        c.lamp(f"estrada_o{k}", -5.0, z)
        c.lamp(f"estrada_l{k}", 5.0, z)
    # Moinho a oeste: torre de pedra com as pás do kit na face leste
    c.tower("Moinho", -44.4, -98.0, 4, pal="creme_vermelho", roof="roof-high-point")
    c.place("kenney", "windmill", -44.4 + K + 0.24 * 3.4 + 0.15, 3.2 * K - 1.0, -96.6, 0.0, 3.4, pal="creme_vermelho", tag="windmill", dyn="spin:moinho")
    c.zone("MoinhoZ", -52.0, -104.0, -36.0, -90.0, "Moinho do Campo", "Farinha para a Padaria da Rosa", priority=1)
    for k in range(4):
        kk("crate_large" if k % 2 else "barrel_large", -46.6 + k * 1.2, -94.2, s=0.42, collide=f"Col_Moinho_{k}")
    # Pomar (grade com folga para andar)
    for i in range(5):
        for j in range(4):
            x, z = -60.0 + i * 4.2 + rng.uniform(-0.4, 0.4), -80.0 + j * 4.4 + rng.uniform(-0.4, 0.4)
            if z > -82.0:
                continue
            c.tree(rng.choice(["Tree_2_A_Color1", "Tree_6_A_Color1", "Tree_1_A_Color1"]), x, z, s=0.85, r=rng.uniform(0, 6.28))
    for i in range(5):
        for j in range(3):
            x, z = -60.0 + i * 4.2 + rng.uniform(-0.4, 0.4), -92.0 - j * 4.4 + rng.uniform(-0.4, 0.4)
            if -52.5 < x < -35.5 and -104 < z < -90:
                continue
            c.tree(rng.choice(["Tree_2_A_Color1", "Tree_6_A_Color1"]), x, z, s=0.85, r=rng.uniform(0, 6.28))
    # Estábulos a leste: estrebaria de madeira, piquete cercado com porteira
    c.building("Estabulo", 36.0, -102.0, 4, 2, floors=1, ridge="x", pal="pedra_escura", style="wood", room="armazem",
               doors=[(41.6, -96.4)], title="Estábulos do Castelo", sub="Cavalos da Guarda · Feno & Arreios")
    px0, pz0, px1, pz1 = 36.0, -93.6, 50.0, -86.6 + 0.0
    nfx = 5
    for k in range(nfx):
        xa = px0 + (k + 0.5) * (px1 - px0) / nfx
        if k != 2:
            c.place_centered("kenney", "fence", xa, 0.0, pz1, -PI / 2, [K, K, (px1 - px0) / nfx], tag="yard_fence", collide=f"Col_Piquete_S{k}")
    c.place_centered("kenney", "fence-gate", px0 + 2.5 * (px1 - px0) / nfx, 0.0, pz1, -PI / 2, [K, K, (px1 - px0) / nfx], tag="yard_fence",
                     hinge={"key": "porteira", "node": "gate", "axis": "y", "angle": 1.6, "dur": 1.0, "open": False})
    gx = px0 + 2.5 * (px1 - px0) / nfx
    c.gates.append({"key": "porteira", "hinge": "porteira", "open": False})
    gd = {"label": "Gate_porteira", "minX": round(gx - 1.4, 3), "maxX": round(gx + 1.4, 3), "minZ": pz1 - 0.15, "maxZ": pz1 + 0.15, "minY": 0.0, "maxY": 1.1, "gate": "porteira"}
    c.colliders.append(gd)
    c.interactable("porteira_estabulo", "lever", gx, pz1 + 1.0, "Abrir a porteira", reach=1.6, gate="porteira")
    for k in range(2):
        z = pz0 + (k + 0.5) * (pz1 - pz0) / 2
        c.place_centered("kenney", "fence", px0, 0.0, z, PI, [K, K, (pz1 - pz0) / 2], tag="yard_fence", collide=f"Col_Piquete_O{k}")
        c.place_centered("kenney", "fence", px1, 0.0, z, 0.0, [K, K, (pz1 - pz0) / 2], tag="yard_fence", collide=f"Col_Piquete_L{k}")
    kk("trunk_large_A", 46.0, -91.0, "E", s=0.5, collide="Col_Feno_0")
    kk("bucket", 39.0, -91.5, s=0.6, collide="Col_Balde_Estabulo")
    c.place("kenney", "cart", 54.0, 0.0, -95.0, 0.3, 2.0, pal="base", tag="cart", collide="Col_Carroca_Estabulo", pad=-0.05)
    c.zone("EstabuloZ", 34.0, -104.0, 58.0, -84.0, "Estábulos do Castelo", "Cavalos da Guarda · Feno & Arreios", priority=1)
    # Campo de treino: postes-alvo, barreiras e armas
    for k, (x, z) in enumerate(((40.0, -74.0), (44.0, -74.0), (48.0, -74.0), (52.0, -74.0))):
        kk("post", x, z, s=[0.8, 0.45, 0.8], collide=f"Col_Alvo_{k}")
        kk("barrel_small", x, z, y=1.0, s=0.5)
    kk("barrier", 46.0, -78.5, "S", s=[1.2, 0.9, 0.8], collide="Col_Treino_Barreira")
    kk("sword_shield", 38.0, -78.0, "E", y=0.0, s=0.6, collide="Col_Treino_Armas")
    kk("sword_shield_broken", 55.0, -78.0, "W", y=0.0, s=0.6, collide="Col_Treino_Armas2")
    bench("Treino_Bench", 46.0, -70.0, "N")
    c.zone("TreinoZ", 36.0, -82.0, 58.0, -68.0, "Campo de Treino", "Onde a Guarda do Marquês sua a camisa", priority=1)
    # Bonecos de treino (enemies.json 'boneco', treino: único inimigo intramuros; nunca ataca nem dá recompensa)
    c.enemy_spawn("boneco_treino_1", "boneco", 41.5, -79.6, PI, leash=0.0)
    c.enemy_spawn("boneco_treino_2", "boneco", 50.5, -79.6, PI, leash=0.0)
    houses_field = [
        ("CasaC1", -26.0, -80.0, 3, 2, 1, "creme_verde", (-21.8, -74.4), "wood"),
        ("CasaC2", 14.0, -80.0, 3, 2, 2, "creme_laranja", (18.2, -74.4), "timber"),
        ("CasaC3", 14.0, -100.0, 3, 2, 2, "ocre_azul", (18.2, -94.4), "plaster"),
    ]

    # ------------------------------------------------------------------ Castelo de Alvor
    # Silhueta de capital, não de forte: muralha de 9,6 m, torres de alturas variadas (embasamento de pedra até a
    # altura da muralha, corpo caiado acima, coruchéus azuis esticados) e a torre de menagem (~31 m + coruchéu)
    # atrás do Salão do Marquês, visível da Praça do Marco por cima dos telhados.
    cx0, cx1, cz0, cz1 = -CASTLE_X, CASTLE_X, WALL_N, CASTLE_FRONT
    ch, ct = 2.4, 1.6                     # muralha do castelo: 9,6 m de altura, 1,6 m de espessura
    tw = 2.8 * 2
    stone_floors = 4                      # 4 x 2,8 = 11,2 m de pedra: cobre a muralha e o adarve

    def castle_tower(key: str, x0: float, z0: float, floors: int, spire: float, cells: int = 2, base: int = stone_floors) -> None:
        c.big_tower(key, x0, z0, cells=cells, floors=floors, pal="branco_azul", base_pal="pedra_azul", base_floors=base,
                    window_every=2, spire=spire)

    # Fundo mais alto que a frente (o castelo "sobe" em direção à menagem); torres do portão as mais esbeltas
    mid_z = (cz0 + cz1) * 0.5
    for key, (x, z), floors, spire in (("CasteloNO", (cx0, cz0), 8, 2.6), ("CasteloNE", (cx1, cz0), 8, 2.6),
                                       ("CasteloSO", (cx0, cz1), 7, 2.4), ("CasteloSE", (cx1, cz1), 7, 2.4),
                                       ("CasteloO", (cx0, mid_z), 6, 2.2), ("CasteloL", (cx1, mid_z), 6, 2.2)):
        castle_tower(key, x - tw * 0.5, z - tw * 0.5, floors, spire)
    castle_tower("CasteloPortaoO", -4.0 - tw, cz1 - tw * 0.5, 7, 3.0)
    castle_tower("CasteloPortaoL", 4.0, cz1 - tw * 0.5, 7, 3.0)
    c.gate("portao_castelo", 0.0, cz1, 0.0, sx=2.0, sy=ch, sz=ct, open_=True, tag="castle_wall")   # 8 m entre as torres
    # Estandartes compridos pendurados nas torres do portão, voltados para a estrada
    for k, x in enumerate((-4.0 - tw * 0.5, 4.0 + tw * 0.5)):
        kk("banner_patternC_blue" if k else "banner_patternB_blue", x, cz1 + tw * 0.5 + 0.12, "S", y=6.2, s=1.6)
    for x, side in ((-2.4, "o"), (2.4, "l")):
        kk("torch_mounted", x, cz1 + 0.9, "S", y=2.8, s=0.9)
    c.interactable("sarilho_castelo", "lever", 3.0, cz1 - 2.0, "Girar o sarilho do portão do castelo", reach=1.6, gate="portao_castelo")
    c.interactable("sarilho_castelo_fora", "lever", -3.0, cz1 + 2.0, "Girar o sarilho do portão do castelo", reach=1.6, gate="portao_castelo")
    c.light("CasteloPortao", 0.0, 3.4, cz1 + 2.6, "#ffa045", 8.0, 13.0, flicker=0.15, importance=1.4, pool=4.6, glow=1.4)
    c.interactable("placa_castelo", "sign", 5.2, cz1 + 3.6, "Ler o brasão do castelo", reach=1.8, title="Castelo de Alvor",
                   text="Sede da Marca de Alvor desde a Primeira Aurora. O pátio fica aberto aos cidadãos do nascer do sol ao "
                        "toque do sino; o Salão do Marquês recebe petições ao meio-dia.")
    hb = tw * 0.5
    c.wall_run("Castelo_S_O", cx0 + hb, cz1, -4.0 - tw, cz1, height=ch, thick=ct, tag="castle_wall")
    c.wall_run("Castelo_S_L", 4.0 + tw, cz1, cx1 - hb, cz1, height=ch, thick=ct, tag="castle_wall")
    for side, x in (("O", cx0), ("L", cx1)):
        mid = (cz0 + cz1) * 0.5
        c.wall_run(f"Castelo_{side}1", x, cz0 + hb, x, mid - hb, height=ch, thick=ct, tag="castle_wall")
        c.wall_run(f"Castelo_{side}2", x, mid + hb, x, cz1 - hb, height=ch, thick=ct, tag="castle_wall")
    c.wall_run("Castelo_N", cx0 + hb, cz0, cx1 - hb, cz0, height=ch, thick=ct, tag="castle_wall")
    for k, x in enumerate((-20.0, -10.0, 10.0, 20.0)):
        banner_pole(f"castelo_{k}", x, cz1 + 1.2, "S", "banner_patternC_blue" if k % 2 else "banner_patternB_blue")
    c.zone("Castelo", cx0, cz0, cx1, cz1, "Castelo de Alvor", "Pátio de Armas · Paço do Marquês", priority=1, marco="Castelo")
    c.zone("CasteloPortaoZ", -10.0, cz1 - 3.0, 10.0, cz1 + 6.0, "Portão do Castelo", "Rastrilho de Carvalho · Guarda do Marquês", priority=2)
    # Paço do Marquês (torre de menagem com salão real)
    # Salão de pé-direito alto (11,2 m, sem assoalho intermediário), caiado com telhado azul
    c.building("Paco", -9.8, -148.4, 7, 4, floors=4, ridge="x", pal="branco_azul", style="plaster", interior=True, room="salao",
               doors=[(0.0, -137.2)], window="wall-window-stone", upper_window="wall-window-small", mezzanine=False, window_floors=(1, 3),
               title="Salão do Marquês", sub="Paço do Marquês · Sede da Marca de Alvor", door_open=True)
    for key, x in (("PacoTorreO", -9.8 - tw), ("PacoTorreL", 9.8)):
        castle_tower(key, x, -148.4, 8, 2.6, base=2)
    # Torre de menagem: 3 x 3 células, 11 andares (30,8 m) + coruchéu, encostada no fundo do salão e
    # atravessando a muralha norte (a base fica dentro da torre; o lado de fora é inacessível)
    castle_tower("Menagem", -4.2, -157.0, 11, 2.4, cells=3)
    # Salão: trono sobre o fundo, colunatas, mesas do banquete, braseiros e estandartes
    kk("chair", 0.0, -147.0, "S", s=1.3, collide="Col_Trono")
    kk("banner_patternA_blue", 0.0, -148.05, "S", y=0.9, s=0.75)
    for x in (-2.0, 2.0):
        kk("banner_thin_blue", x, -148.05, "S", y=1.0, s=0.6)
        chest(f"trono_{'o' if x < 0 else 'l'}", x * 1.2, -147.2, "S", gold=True, label="Abrir o cofre do Marquês")
    for k, z in enumerate((-145.4, -142.6, -139.8)):
        for x in (-4.4, 4.4):
            kk("pillar", x, z, s=[0.32, 0.68, 0.32], collide=f"Col_Coluna_{k}_{x}")
    for x in (-7.2, 7.2):
        kk("table_long_tablecloth_decorated_A", x, -143.0, r=0.0, s=0.75, collide=f"Col_Banquete_{x}", pad=-0.05)
        for z in (-144.6, -141.4):
            kk("bench", x + (-1.15 if x < 0 else 1.15), z, "E" if x < 0 else "W", s=0.7, tag="seat")
        seat(f"banco_salao_{x}", x + (-1.15 if x < 0 else 1.15), -143.0, "E" if x < 0 else "W", label="Sentar à mesa do banquete", reach=1.3)
        kk("candle_triple", x, -143.0, y=0.78, s=0.55)
        kk("plate_food_A", x, -144.2, y=0.78, s=0.45)
        kk("plate_food_B", x, -141.8, y=0.78, s=0.45)
    for k, (x, z) in enumerate(((-2.8, -145.6), (2.8, -145.6))):
        brazier(f"salao_{k}", x, z, light=False)
    kk("wall_arched", -9.55, -142.8, "E", s=0.55, collide="Col_Salao_Lareira")
    kk("trunk_medium_A", -9.1, -142.8, "E", s=0.55, collide="Col_Salao_Logs")
    c.anchor("SalaoLareira", -9.1, 0.35, -142.8, fire="hearth", size=1.0)
    c.interactable("lareira_salao", "hearth", -8.0, -142.8, "Aquecer as mãos", reach=1.8)
    c.light("SalaoTrono", 0.0, 2.4, -145.0, "#ffc27a", 9.0, 13.0, flicker=0.08, zone="Paco", importance=2.6, glow=0.0)
    c.light("SalaoLareira", -8.6, 0.9, -142.8, "#ff7a2a", 10.0, 11.0, flicker=0.3, zone="Paco", importance=2.4, glow=0.0)
    c.light("SalaoEntrada", 0.0, 2.4, -139.0, "#ffd29a", 6.0, 10.0, flicker=0.04, zone="Paco", importance=1.8, glow=0.0)
    for x in (-8.6, 8.6):
        kk("torch_mounted", x + (0.95 if x < 0 else -0.95), -138.6, "E" if x < 0 else "W", y=1.7, s=0.7)
    # Pátio de armas
    for x in (-3.4, 3.4):
        brazier(f"paco_{x}", x, -135.4, light=x < 0)
    c.place("kenney", "fountain-square", -14.0, 0.0, -122.0, 0.0, 1.3, pal="pedra", tag="well", collide="Col_Poco_Castelo", pad=-0.1)
    kk("bucket", -13.0, -121.0, s=0.5)
    c.interactable("poco_castelo", "drink", -14.0, -120.2, "Tirar água do poço do castelo", reach=1.5, restore={"vigor": 15, "calor": 0})
    c.building("Quartel", 16.8, -131.6, 4, 2, floors=2, ridge="x", pal="pedra_azul", style="stone", room="quartel",
               doors=[(22.4, -126.0)], title="Quartel da Guarda", sub="Beliches, Armas & Escalas de Ronda", window="wall-window-stone")
    c.building("Armazem", -28.0, -131.6, 4, 2, floors=1, ridge="x", pal="pedra", style="wood", room="armazem",
               doors=[(-22.4, -126.0)], title="Armazém do Castelo", sub="Grãos, Lenha & Barris de Sidra")
    for k, (x, z, n) in enumerate(((-26.4, -124.2, "crates_stacked"), (-24.6, -124.0, "barrel_large"), (-18.6, -124.4, "box_stacked"),
                                   (26.0, -123.6, "barrel_small_stack"), (15.0, -124.0, "crate_large"))):
        kk(n, x, z, s=0.45, collide=f"Col_Patio_{k}")
    for k, (x, z) in enumerate(((10.0, -116.0), (13.0, -116.0), (16.0, -116.0))):
        kk("post", x, z, s=[0.8, 0.45, 0.8], collide=f"Col_PatioAlvo_{k}")
        kk("barrel_small", x, z, y=1.0, s=0.5)
    kk("sword_shield", 18.4, -116.0, "W", s=0.6, collide="Col_Patio_Armas")
    c.tower("Campanario", -26.4, -116.6, 7, pal="branco_azul", spire=1.8)
    c.interactable("sino_castelo", "bell", -25.0, -113.2, "Tocar o sino do castelo", reach=1.8)
    for k, (x, z, face) in enumerate(((-8.0, -126.0, "E"), (8.0, -126.0, "W"))):
        bench(f"Patio_Bench_{k}", x, z, face)
    for name, (x, z) in (("p1", (-6.0, -115.0)), ("p2", (6.0, -115.0)), ("p3", (-10.0, -133.0)), ("p4", (10.0, -133.0))):
        c.lamp(f"castelo_{name}", x, z)
    for k, (x, z) in enumerate(((-28.0, -112.0), (28.0, -112.0), (-20.0, -150.0), (20.0, -150.0))):
        c.tree("Tree_3_A_Color1" if k % 2 else "Tree_5_A_Color1", x, z, s=1.0, r=rng.uniform(0, 6.28))
    c.zone("PatioCastelo", -28.0, -137.0, 28.0, -110.0, "Pátio de Armas", "Castelo de Alvor · Quartel · Campanário", priority=1)

    # ------------------------------------------------------------------ Bairros residenciais
    houses = [
        # (chave, x0, z0, W, D, andares, paleta, porta(x,z), estilo)
        ("CasaL1", 18.0, -23.2, 4, 2, 2, "creme_azul", (23.6, -17.6), "timber"),
        ("CasaL2", 31.6, -23.2, 3, 2, 2, "ocre_vermelho", (35.8, -17.6), "plaster"),
        ("CasaL3", 42.0, -28.8, 4, 4, 3, "creme_verde", (47.6, -17.6), "timber"),
        ("CasaL4", 55.0, -23.2, 3, 2, 2, "creme_roxo", (59.2, -17.6), "wood"),
        ("CasaL5", 24.0, 16.0, 3, 2, 2, "creme_vermelho", (28.2, 16.0), "plaster"),
        ("CasaL6", 36.0, 16.0, 4, 2, 2, "ocre_azul", (41.6, 16.0), "timber"),
        ("CasaL7", 50.0, 16.0, 4, 2, 3, "creme_laranja", (55.6, 16.0), "plaster"),
        ("CasaL8", 26.0, 34.0, 4, 2, 2, "creme_verde", (31.6, 34.0), "wood"),
        ("CasaL9", 42.0, 36.0, 3, 2, 2, "creme_azul", (46.2, 36.0), "timber"),
        ("CasaN1", 18.0, -40.0, 4, 2, 2, "ocre_vermelho", (23.6, -34.4), "timber"),
        ("CasaN2", 32.0, -42.0, 4, 4, 2, "creme_azul", (37.6, -30.8), "plaster"),
        ("CasaN3", -30.0, -46.0, 4, 2, 2, "creme_laranja", (-24.4, -40.4), "wood"),
        ("CasaO1", -58.0, -23.2, 4, 2, 2, "creme_verde", (-52.4, -17.6), "timber"),
        ("CasaO2", -58.0, -40.0, 4, 2, 2, "creme_vermelho", (-52.4, -34.4), "plaster"),
        ("CasaRosa", -30.0, 16.0, 3, 2, 2, "creme_laranja", (-25.8, 16.0), "plaster"),
        ("CasaO3", -44.0, 16.0, 4, 2, 2, "ocre_azul", (-38.4, 16.0), "timber"),
        ("CasaO4", -58.0, 16.0, 4, 2, 3, "creme_azul", (-52.4, 16.0), "wood"),
        ("CasaO5", -46.0, 36.0, 4, 2, 2, "creme_vermelho", (-40.4, 36.0), "timber"),
        ("CasaO6", -30.0, 40.0, 3, 2, 2, "creme_roxo", (-25.8, 40.0), "plaster"),
    ] + houses_north + houses_field
    # Variedade por casa (sorteio determinístico pelo nome): embasamento de pedra, desenho do enxaimel,
    # águas-furtadas e marquise na porta; casas de tábua ficam sem embasamento (galpão de madeira)
    timber_patterns = ("wall-detail-cross", "wall-detail-diagonal", "wall-detail-horizontal")
    for key, x0, z0, W, D, fl, pal, door, style in houses:
        mix = zlib_mix(key)
        plinth = None if style == "wood" else ("pedra_escura", "pedra", None)[(mix >> 3) % 3]
        c.building(key, x0, z0, W, D, floors=fl, ridge="x", pal=pal, doors=[door], style=style,
                   chimney=(W - 1, 0) if (mix % 2) else None, lit=0.55, plinth=plinth,
                   timber_pattern=timber_patterns[(mix >> 5) % 3], dormers=(mix >> 7) % 3 if W >= 3 else 0,
                   awning=bool((mix >> 9) % 2))
    c.zone("CasaRosaZ", -30.0, 12.0, -21.6, 16.0, "Casa da Dona Rosa", "Cheiro de Pão até na Rua", priority=2)
    # Poço comunitário (bacia de pedra do chafariz + balde)
    c.place("kenney", "fountain-square", -26.0, 0.0, 30.0, 0.0, 1.3, pal="base", tag="well", collide="Col_Well", pad=-0.1)
    kk("bucket", -24.9, 30.9, s=0.5)
    c.interactable("poco_beco", "drink", -26.0, 31.9, "Tirar água do poço", reach=1.5, restore={"vigor": 15, "calor": 0})
    c.lamp("poco", -23.0, 27.4)
    # Árvores dos bairros e jardins de casa
    yards = [(24.0, -6.0, 60.0, -1.0), (36.0, 24.0, 62.0, 31.0), (-60.0, -5.0, -42.0, 6.0), (-60.0, 24.0, -48.0, 33.0),
             (24.0, -62.0, 60.0, -46.0), (-60.0, -62.0, -36.0, -48.0), (24.0, 42.0, 62.0, 60.0), (-60.0, 46.0, -24.0, 60.0),
             (-58.0, -32.0, -46.0, -26.0), (46.0, 22.0, 62.0, 30.0), (14.0, 44.0, 22.0, 60.0), (-22.0, 46.0, -12.0, 60.0),
             (-34.0, -104.0, -10.0, -92.0), (24.0, -106.0, 62.0, -104.0), (-62.0, -106.0, -36.0, -102.0)]
    trees = ["Tree_1_A_Color1", "Tree_2_A_Color1", "Tree_3_A_Color1", "Tree_4_A_Color1", "Tree_5_A_Color1", "Tree_6_A_Color1", "Tree_7_A_Color1"]
    blocked = [(b.box.minX - 1.6, b.box.minZ - 1.6, b.box.maxX + 1.6, b.box.maxZ + 1.6) for b in c.buildings.values()]
    blocked += [(s["minX"] - 1.2, s["minZ"] - 1.2, s["maxX"] + 1.2, s["maxZ"] + 1.2) for s in c.cobble]
    blocked += [(z["minX"] - 1.0, z["minZ"] - 1.0, z["maxX"] + 1.0, z["maxZ"] + 1.0) for z in c.zones if z["key"] in ("MoinhoZ", "EstabuloZ", "TreinoZ")]
    for x0, z0, x1, z1 in yards:
        n = int((x1 - x0) * (z1 - z0) / 55)
        for _ in range(n):
            x, z = rng.uniform(x0, x1), rng.uniform(z0, z1)
            if any(a <= x <= cx and b <= z <= d for a, b, cx, d in blocked):
                continue
            if rng.random() < 0.6:
                c.tree(rng.choice(trees), x, z, s=rng.uniform(0.95, 1.35), r=rng.uniform(0, 6.28))
            else:
                c.place("forest", rng.choice(["Bush_3_A_Color1", "Bush_2_A_Color1", "Rock_1_A_Color1"]), x, 0.0, z,
                        rng.uniform(0, 6.28), rng.uniform(1.6, 2.6), tag="bush", cast=False)
    for k, x in enumerate((24, 38, 52)):
        c.lamp(f"rl{k}", x, -12.9)
        c.lamp(f"rf{k}", x, 13.5)
    for k, x in enumerate((-24, -40, -54)):
        c.lamp(f"rt{k}", x, -12.9)
        c.lamp(f"rp{k}", x + (3.4 if k == 0 else 0.0), 13.5)
    for k, z in enumerate((-22, -38)):
        c.lamp(f"avo{k}", -13.8, z)
        c.lamp(f"avl{k}", 13.8, z)
    c.collectible("bolinho", 22.2, 28.2, [{"kit": "pets", "name": "animal-cat", "x": 22.2, "z": 28.2, "s": 0.32, "r": -0.6}], reach=1.6)

    # ------------------------------------------------------------------ Floresta e colinas fora da muralha
    rect = (-WALL_X - 5.0, WALL_N - 5.0, WALL_X + 5.0, WALL_S + 5.0)
    placed = 0
    while placed < 190:
        x, z = rng.uniform(-148.0, 148.0), rng.uniform(-196.0, 205.0)
        if rect[0] < x < rect[2] and rect[1] < z < rect[3]:
            continue
        if -127.0 < x < 127.0 and 63.0 < z < 188.0:
            continue
        if abs(x) < 9 and z > WALL_S:          # estrada do Portão Sul
            continue
        placed += 1
        if rng.random() < 0.75:
            c.place("kenney", rng.choice(["tree-high", "tree", "tree-high-crooked"]), x, -0.1, z, rng.uniform(0, 6.28), rng.uniform(2.6, 3.8), pal="base", tag="forest")
        else:
            c.place("forest", rng.choice(["Tree_1_A_Color1", "Tree_2_A_Color1", "Tree_5_A_Color1"]), x, -0.1, z, rng.uniform(0, 6.28), rng.uniform(1.4, 2.2), tag="forest")

    # ------------------------------------------------------------------ Navegação (NPCs)
    n = c.node
    n("praca_n", 0.0, -9.0); n("praca_s", 0.0, 8.6); n("praca_l", 11.0, 0.6); n("praca_o", -11.0, -0.6)
    n("praca_ne", 10.0, -8.4); n("praca_no", -10.0, -8.4); n("praca_se", 9.8, 7.6); n("praca_so", -9.8, 7.6)
    n("marco", 2.6, 3.4, look=(0.0, 0.0))
    n("praca_mercado", 8.6, 8.4, look=(8.6, 10.6)); n("praca_barraca_n", 10.2, -3.6, look=(12.4, -5.4))
    c.link("praca_n", "praca_ne", "praca_l", "praca_se", "praca_s", "praca_so", "praca_o", "praca_no", "praca_n")
    c.link("praca_s", "marco"); c.link("praca_se", "praca_mercado"); c.link("praca_l", "praca_barraca_n")
    # Estalagem
    n("inn_porta", 0.0, -12.4, look=(0.0, -6.0)); n("inn_porta_dentro", 0.0, -15.4); n("inn_centro", 0.0, -17.6)
    n("inn_mesa_o", -3.8, -15.45, look=(-3.8, -16.6), seat=0.0); n("inn_mesa_l", 3.8, -15.45, look=(3.8, -16.6), seat=0.0)
    n("inn_luna", 2.4, -19.45, look=(2.4, -21.0), seat=0.0); n("inn_luna_pe", 3.6, -18.3)
    n("inn_lareira", -4.9, -18.6, look=(-6.8, -18.6)); n("inn_balcao_fim", 4.3, -21.9)
    n("inn_bram", 0.0, -21.9, look=(0.0, -18.0)); n("inn_barris", -4.2, -22.6, look=(-5.6, -24.0))
    n("inn_kegs", 3.9, -23.0, look=(5.0, -23.9)); n("inn_fundos_dentro", 2.8, -23.9)
    n("inn_fundos", 2.8, -26.6); n("patio_lenha", 2.4, -30.6, look=(2.4, -32.3))
    c.link("praca_n", "inn_porta", "inn_porta_dentro", "inn_centro", "inn_luna_pe", "inn_luna")
    c.link("inn_porta_dentro", "inn_mesa_o"); c.link("inn_porta_dentro", "inn_mesa_l")
    c.link("inn_centro", "inn_lareira"); c.link("inn_luna_pe", "inn_balcao_fim", "inn_bram", "inn_barris")
    c.link("inn_balcao_fim", "inn_kegs"); c.link("inn_balcao_fim", "inn_fundos_dentro", "inn_fundos", "patio_lenha")
    # Guilda
    n("guilda_porta", 16.4, -1.4, look=(14.0, -1.4)); n("guilda_dentro", 19.8, -1.4); n("guilda_centro", 24.0, -1.0)
    n("guilda_quadro", 24.0, -3.5, look=(24.0, -5.6)); n("guilda_atras", 30.3, -3.7); n("guilda_maren", 30.2, 0.0, look=(26.0, 0.0))
    n("guilda_mesa", 20.4, 2.6, look=(22.8, 2.6))
    c.link("praca_l", "guilda_porta", "guilda_dentro", "guilda_centro", "guilda_quadro", "guilda_atras", "guilda_maren")
    c.link("guilda_dentro", "guilda_mesa")
    # Templo e jardim
    # Irmã Celeste fica diante do altar, voltada para ele; entra pela porta norte do pórtico (entre as duas portas
    # há o pilar da parede, então a rota passa por z = -1,4) e segue pelo corredor central, entre os bancos
    n("templo_escada", -14.0, 0.0); n("templo_porta", -17.2, -1.4); n("templo_nave", -20.2, -1.4)
    n("templo_corredor", -21.6, 0.0); n("templo_celeste", -42.6, 0.0, look=(-46.0, 0.0))
    c.link("praca_o", "templo_escada", "templo_porta", "templo_nave", "templo_corredor", "templo_celeste")
    n("rua_t1", -20.0, -10.3); n("rua_t2", -31.0, -10.3); n("rua_oeste", -45.0, -10.3); n("rua_t4", -58.0, -10.3)
    c.link("praca_no", "rua_t1", "rua_t2", "rua_oeste", "rua_t4")
    n("jardim_s", -31.0, -15.6); n("jardim_fonte", -31.0, -19.9, look=(-31.0, -23.0)); n("jardim_l", -27.2, -20.4)
    n("jardim_banco", -26.2, -23.6, look=(-31.0, -23.6), seat=0.0); n("jardim_ne", -27.0, -28.8); n("jardim_n", -31.0, -29.6, look=(-31.0, -31.0))
    c.link("rua_t2", "jardim_s", "jardim_fonte", "jardim_l", "jardim_banco"); c.link("jardim_l", "jardim_ne", "jardim_n")
    # Mercado e portão
    n("mercado_n", 0.0, 13.0); n("mercado_1", 0.0, 19.0); n("mercado_2", 0.0, 27.0); n("mercado_3", 0.0, 35.0)
    n("mercado_4", 0.0, 43.0); n("mercado_s", 0.0, 52.0); n("portao_dentro", 0.0, 58.0)
    n("portao_aldric", 2.4, 60.6, look=(0.0, 64.0)); n("portao_guarita", -4.0, 60.6, look=(-6.0, 63.0))
    c.link("praca_s", "mercado_n", "mercado_1", "mercado_2", "mercado_3", "mercado_4", "mercado_s", "portao_dentro", "portao_aldric")
    c.link("portao_dentro", "portao_guarita")
    n("padaria", -4.9, 20.2, look=(4.0, 20.2)); n("padaria_forno", -3.4, 23.0, look=(-5.2, 23.0))
    n("botica", -4.9, 32.2, look=(4.0, 32.2)); n("darian", 5.0, 32.2, look=(-4.0, 32.2))
    n("forja_entrada", 8.6, 17.6); n("forja_bigorna", 8.8, 19.6, look=(7.9, 19.6)); n("forja", 7.6, 21.4, look=(8.6, 22.8))
    c.link("mercado_1", "padaria"); c.link("mercado_1", "padaria_forno"); c.link("mercado_3", "botica"); c.link("mercado_3", "darian")
    c.link("mercado_1", "forja_entrada", "forja_bigorna", "forja")
    # Ruas laterais
    n("rua_l1", 20.0, -10.3); n("rua_leste", 34.0, -10.3); n("rua_l3", 50.0, -10.3)
    c.link("praca_ne", "rua_l1", "rua_leste", "rua_l3")
    n("rua_f1", 18.0, 10.8); n("rua_f2", 34.0, 10.8); n("rua_f3", 50.0, 10.8)
    c.link("praca_se", "rua_f1", "rua_f2", "rua_f3")
    n("rua_p1", -20.0, 10.8); n("casa_rosa", -25.8, 14.4, look=(-25.8, 16.0)); n("rua_p2", -31.4, 10.8); n("rua_p3", -45.0, 10.8)
    c.link("praca_so", "rua_p1", "casa_rosa", "rua_p2", "rua_p3")
    n("beco_poco", -31.4, 24.0); n("poco", -28.3, 29.0, look=(-26.0, 30.0))
    c.link("rua_p2", "beco_poco", "poco")
    n("av_o1", -10.4, -22.0); n("av_o2", -10.4, -40.0); n("av_l1", 10.4, -22.0); n("av_l2", 10.4, -40.0)
    # Largo do Portão Norte, campo e castelo
    n("paco_portao", 0.0, -60.0, look=(0.0, -66.0)); n("largo_poco", -6.6, -53.0, look=(-9.0, -55.0))
    c.link("praca_no", "av_o1", "av_o2", "paco_portao", "av_l2", "av_l1", "praca_ne")
    c.link("paco_portao", "largo_poco")
    n("portao_norte_fora", 0.0, -70.0); n("estrada_1", 0.0, -86.0); n("estrada_2", 0.0, -100.0)
    n("castelo_portao_fora", 0.0, -104.0, look=(0.0, -108.0)); n("castelo_portao_dentro", 0.0, -112.0)
    n("castelo_patio", 0.0, -122.0); n("castelo_poco", -11.6, -120.6, look=(-14.0, -122.0)); n("castelo_quartel", 22.4, -124.0, look=(22.4, -126.0))
    n("castelo_paco", 0.0, -134.0, look=(0.0, -137.2)); n("salao_entrada", 0.0, -139.4); n("salao_trono", 0.0, -144.8, look=(0.0, -147.0))
    n("castelo_sino", -24.0, -112.4, look=(-25.0, -116.6)); n("castelo_treino", 13.0, -114.0, look=(13.0, -116.0))
    n("campo_moinho", -40.0, -86.0, look=(-43.0, -96.6)); n("campo_estabulo", 41.6, -86.0); n("campo_treino", 46.0, -81.2, look=(46.0, -74.0))
    c.link("paco_portao", "portao_norte_fora", "estrada_1", "estrada_2", "castelo_portao_fora", "castelo_portao_dentro", "castelo_patio",
           "castelo_paco", "salao_entrada", "salao_trono")
    c.link("castelo_patio", "castelo_poco"); c.link("castelo_patio", "castelo_quartel"); c.link("castelo_portao_dentro", "castelo_sino")
    c.link("castelo_portao_dentro", "castelo_treino")
    c.link("estrada_1", "campo_moinho"); c.link("estrada_1", "campo_estabulo", "campo_treino")

    urban_details.build(c)
    south_outskirts.build(c)


def zlib_mix(key: str) -> int:
    import zlib
    return zlib.crc32(key.encode("utf-8"))
