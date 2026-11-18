"""Enriquecimento de interiores e fachadas urbanas (Guilda, Taverna, Oficina do Darian e Portão Sul)."""
from __future__ import annotations

import math

KK = 0.8
PI = math.pi
FACE = {"S": 0.0, "N": PI, "E": PI / 2, "W": -PI / 2}


def build(c) -> None:
    def place_prop(kit: str, name: str, x: float, z: float, *, y: float = 0.0, face: str = "S", r: float | None = None,
                   s=KK, collide: str | None = None, pad: float = 0.0, tag: str = "urban_detail"):
        rot = FACE[face] if r is None else r
        return c.place(kit, name, x, y, z, rot, s, tag=tag, collide=collide, pad=pad)

    # ------------------------------------------------------------------ Guilda dos Aventureiros
    # Balcão da Maren (x=28.6, já protegido por Col_Guild_Counter): grimório aberto, grimório fechado e varinha
    place_prop("adv", "spellbook_open", 28.6, -0.25, y=0.94, r=-PI / 2, s=0.5)
    place_prop("adv", "spellbook_closed", 28.6, 0.65, y=0.95, r=-PI / 2 + 0.25, s=0.5)
    place_prop("adv", "wand", 28.6, -0.75, y=0.94, r=0.3, s=0.5)

    # Mesas do salão (já protegidas por Col_Guild_RoundTable e Col_Guild_Table)
    place_prop("adv", "mug_full", 25.3, 3.6, y=0.62, r=0.2, s=0.5)
    place_prop("adv", "spellbook_closed", 22.3, 2.55, y=0.95, r=0.4, s=0.48)

    # Canto sudoeste da Guilda: barril decorado com aljava e feixe de flechas apoiados
    place_prop("dungeon", "barrel_large_decorated", 18.9, 4.7, y=0.0, s=0.45, collide="Col_Guild_Barrel")
    place_prop("adv", "quiver", 19.2, 4.45, y=0.45, r=-0.4, s=0.55)

    # Aparador junto à parede norte da Guilda (ao lado do quadro, longe das rotas)
    place_prop("dungeon", "table_small", 27.6, -5.0, y=0.0, s=0.75, collide="Col_Guild_RackTable")
    place_prop("adv", "spellbook_open", 27.6, -5.0, y=0.89, r=0.15, s=0.46)
    place_prop("adv", "quiver", 27.35, -5.0, y=0.96, r=-0.25, s=0.48)
    place_prop("adv", "arrow_bundle", 27.85, -5.0, y=0.98, r=0.35, s=0.48)

    # Cajado junto à estante leste (atrás do balcão, mantendo >= 0.8 m da rota guilda_atras -> guilda_maren)
    place_prop("adv", "staff", 31.35, -1.5, y=0.72, r=0.15, s=0.75, collide="Col_Guild_Staff")

    # Troféus de parede na face norte da Guilda (acima da faixa de colisão do corpo)
    place_prop("adv", "sword_2handed_color", 20.6, -5.3, y=1.65, r=0.0, s=0.55)
    place_prop("adv", "shield_badge_color", 22.5, -5.3, y=1.65, r=0.0, s=0.65)
    place_prop("adv", "arrow_bundle", 26.4, -5.3, y=1.65, r=0.35, s=0.55)

    # ------------------------------------------------------------------ Estalagem Lanterna Torta
    # Canecas e pratos extras sobre as mesas e balcão (colisores já existentes)
    place_prop("adv", "mug_full", -4.1, -16.4, y=0.80, r=0.2, s=0.5)
    place_prop("dungeon", "plate_food_B", -3.5, -16.8, y=0.79, r=0.4, s=0.45)
    place_prop("adv", "mug_empty", 4.1, -16.3, y=0.80, r=-0.3, s=0.5)
    place_prop("adv", "mug_empty", 0.9, -20.55, y=0.80, r=0.1, s=0.5)
    place_prop("dungeon", "coin_stack_small", -0.9, -20.6, y=0.80, r=0.0, s=0.35)

    # Barril decorado na fachada sul da taverna (ao lado da porta, fora da rota)
    place_prop("dungeon", "barrel_large_decorated", -5.2, -13.2, y=0.0, s=0.45, collide="Col_Inn_PorchBarrel")

    # ------------------------------------------------------------------ Oficina do Velho Darian
    # Miudezas na banca do Darian (Col_Stall_Darian) e barril ao lado da fachada
    place_prop("adv", "spellbook_closed", 5.3, 34.2, y=0.84, r=PI / 2, s=0.42)
    place_prop("dungeon", "book_tan", 5.3, 35.0, y=0.72, r=0.5, s=0.4)
    place_prop("dungeon", "bottle_A_labeled_brown", 5.2, 34.9, y=0.72, r=0.0, s=0.45)
    place_prop("dungeon", "barrel_large", 5.6, 29.2, y=0.0, s=0.44, collide="Col_Darian_Barrel")
    place_prop("dungeon", "candle_lit", 5.6, 29.2, y=0.88, r=0.0, s=0.48)

    # ------------------------------------------------------------------ Guarita do Portão Sul
    # Cão da guarda junto à guarita oeste (perto de (-5.2, 61.5))
    place_prop("pets", "animal-dog", -5.2, 61.5, y=0.0, r=1.1, s=0.42, collide="Col_Gate_Dog")

    # Caixotes e equipamentos da guarda no lado leste do portão (afastados de portao_aldric)
    place_prop("dungeon", "crates_stacked", 5.4, 61.4, y=0.0, r=-0.3, s=0.45, collide="Col_Gate_Crates_E")
    place_prop("adv", "shield_badge_color", 5.4, 60.95, y=0.55, r=0.1, s=0.55)
    place_prop("adv", "quiver", 5.05, 61.4, y=0.45, r=0.3, s=0.55)
