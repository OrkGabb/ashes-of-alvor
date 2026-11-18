#!/usr/bin/env python3
"""
Detalhe pintado nas superfícies do kit Kenney (public/textures/detail.json).

- Classes: em cada paleta publicada, a célula de cada superfície decodifica (pela MESMA fórmula do shader,
  lida de public/js/materials.js) para a camada esperada, também nos níveis de mipmap em que a célula ainda
  tem largura. Controle negativo: o colormap.png original (sem classes) precisa reprovar.
- Camadas: cada public/textures/detail/<id>.png existe em tamanho_px, o detalhe tem média 1 e o contraste
  pedido, e o relevo não é chato (um arquivo neutro reprova).
- Repetição: a diferença entre a última e a primeira coluna/linha (vizinhas ao repetir) é da ordem da diferença
  entre colunas vizinhas do miolo. Controle negativo: uma rampa sintética precisa reprovar.

Uso: python test_detail.py
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent
SPEC = json.loads((ROOT / "public" / "textures" / "detail.json").read_text(encoding="utf-8"))
CITY = json.loads((ROOT / "public" / "assets" / "city" / "city.json").read_text(encoding="utf-8"))
SHADER = (ROOT / "public" / "js" / "materials.js").read_text(encoding="utf-8")
FAILS: list[str] = []
LAYERS = [c["id"] for c in SPEC["camadas"]]


def check(cond: bool, msg: str) -> None:
    if not cond:
        FAILS.append(msg)


SCALE = float(re.search(r"\(1\.0 - sampledDiffuseColor\.a\) \* ([\d.]+) \+ 0\.5", SHADER).group(1))


def decode(alpha8: float) -> int:
    """Classe como o shader calcula: floor((1 - a) * SCALE + 0.5); 0 = sem detalhe, k = camada k - 1."""
    return int(np.floor((1.0 - alpha8 / 255.0) * SCALE + 0.5))


def expected_cells(palette: str) -> dict[tuple[int, int], int]:
    cells = dict(SPEC["celulas"]) | SPEC["paletas"].get(palette, {})
    return {tuple(int(v) for v in k.split(",")): LAYERS.index(layer) + 1 for k, layer in cells.items()}


def palette_errors(path: Path, palette: str) -> list[str]:
    img = Image.open(path).convert("RGBA")
    errors = []
    expect = expected_cells(palette)
    level = img
    for mip in range(4):  # célula de 32 px -> 4 px no nível 3
        a = np.asarray(level)[..., 3].astype(np.float64)
        f = 2 ** mip
        for col in range(16):
            for row in range(4):
                v = a[(row * 128 + 64) // f, (col * 32 + 16) // f]
                want = expect.get((col, row), 0)
                if decode(v) != want:
                    errors.append(f"{path.name} mip{mip} célula {col},{row}: classe {decode(v)}, esperado {want}")
        level = level.resize((level.width // 2, level.height // 2), Image.BOX)
    return errors


def seam_ratio(a: np.ndarray) -> float:
    """Degrau na volta (última -> primeira coluna/linha) dividido pelo degrau típico entre vizinhas do miolo."""
    a = a.astype(np.float64)
    inner_x = np.abs(np.diff(a, axis=1)).mean()
    inner_y = np.abs(np.diff(a, axis=0)).mean()
    wrap_x = np.abs(a[:, 0] - a[:, -1]).mean()
    wrap_y = np.abs(a[0, :] - a[-1, :]).mean()
    return max(wrap_x / (inner_x + 1e-9), wrap_y / (inner_y + 1e-9))


def test_classes() -> None:
    for name, rel in CITY["palettes"].items():
        path = ROOT / "public" / rel.lstrip("./")
        errs = palette_errors(path, name)
        check(not errs, f"paleta {name}: {errs[:3]}")
    colormap = ROOT / "public" / "assets" / "kits" / "kenney" / "Textures" / "colormap.png"
    check(bool(palette_errors(colormap, "base")), "controle negativo: o colormap original (sem classes) passou")


def atlas_errors(path: Path, regions: list[dict]) -> list[str]:
    a = np.asarray(Image.open(path).convert("RGBA"))[..., 3].astype(np.float64)
    errors = []
    for reg in regions:
        x0, y0, x1, y1 = reg["rect"]
        want = LAYERS.index(reg["camada"]) + 1
        got = decode(a[(y0 + y1) // 2, (x0 + x1) // 2])
        if got != want:
            errors.append(f"{path.name} região {reg['rect']}: classe {got}, esperado {want}")
    if decode(a[a.shape[0] - 8, a.shape[1] - 8]) != 0:
        errors.append(f"{path.name}: canto fora das regiões tem classe")
    return errors


def test_atlas() -> None:
    for kit, atlas in SPEC.get("atlas", {}).items():
        published = ROOT / "public" / "assets" / "kits" / kit / atlas["arquivo"]
        errs = atlas_errors(published, atlas["regioes"])
        check(not errs, f"atlas {kit}: {errs}")
        original = ROOT / "assets_src" / f"kaykit_{kit}" / atlas["arquivo"]
        if original.exists():
            check(bool(atlas_errors(original, atlas["regioes"])), f"controle negativo: atlas original de {kit} (sem classes) passou")


def test_layers() -> None:
    size = SPEC["tamanho_px"]
    for layer in SPEC["camadas"]:
        path = ROOT / "public" / "textures" / "detail" / f"{layer['id']}.png"
        if not path.exists():
            FAILS.append(f"camada {layer['id']}: arquivo ausente")
            continue
        img = np.asarray(Image.open(path).convert("RGB")).astype(np.float64) / 255.0
        check(img.shape[:2] == (size, size), f"camada {layer['id']}: {img.shape[:2]} != {size}")
        detail = img[..., 2] * 2.0
        check(abs(detail.mean() - 1.0) < 0.06, f"camada {layer['id']}: detalhe médio {detail.mean():.3f} (esperado 1)")
        std = detail.std()
        check(0.6 * layer["contraste"] < std < 1.4 * layer["contraste"], f"camada {layer['id']}: contraste {std:.3f}, pedido {layer['contraste']}")
        check(img[..., 0].std() > 0.01 and img[..., 1].std() > 0.01, f"camada {layer['id']}: relevo chato")
        ratio = seam_ratio(img[..., 2])
        check(ratio < 1.6, f"camada {layer['id']}: emenda visível ao repetir (razão {ratio:.2f})")
    neutral = np.full((size, size, 3), 0.5)
    check(not (neutral[..., 0].std() > 0.01), "controle negativo: camada neutra passaria como relevo")
    ramp = np.tile(np.linspace(0, 1, size), (size, 1))
    check(seam_ratio(ramp) >= 1.6, f"controle negativo: rampa sem repetição passou (razão {seam_ratio(ramp):.2f})")


def test_ground() -> None:
    manifest = json.loads((ROOT / "public" / "textures" / "manifest.json").read_text(encoding="utf-8"))
    for item in SPEC["chao"]:
        files = manifest["sets"][item["set"]]["files"]
        img = np.asarray(Image.open(ROOT / "public" / "textures" / files["map"]).convert("L")).astype(np.float64)
        ratio = seam_ratio(img)
        check(ratio < 1.6, f"chão {item['set']}: emenda visível ao repetir (razão {ratio:.2f})")


def main() -> int:
    test_classes()
    test_atlas()
    test_layers()
    test_ground()
    if FAILS:
        print("FALHOU:")
        for f in FAILS:
            print("  -", f)
        return 1
    print(f"OK: classes em {len(CITY['palettes'])} paletas (4 níveis de mip) e {len(SPEC.get('atlas', {}))} atlas KayKit, {len(LAYERS)} camadas e chão repetem sem emenda (+ controles negativos)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
