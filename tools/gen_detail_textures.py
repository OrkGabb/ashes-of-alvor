#!/usr/bin/env python3
"""
Texturas pintadas à mão para as superfícies do kit Kenney e para o chão (fonte: public/textures/detail.json).

1. Gera cada imagem com o agy (mesmo caminho do tools/gen_art.py) em assets_src/tex_raw/<id>.png.
2. Torna a imagem repetível: mistura com a própria cópia deslocada em meio quadro, com máscara que vale 1 no
   centro e 0 nas bordas (as bordas vêm do miolo da cópia, contínuo através da volta; a emenda da cópia fica
   no centro, onde a original cobre).
3. Camadas de detalhe -> public/textures/detail/<id>.png: R,G = normal tangente (OpenGL, +Y para cima na
   imagem) do relevo derivado da luminância, B = luminância / média x 0,5 (o shader multiplica a cor da
   paleta por 2B, então o kit mantém as cores e ganha a pintura).
   Chão -> substitui <set>_diff/_norm/_rough.png de public/textures/manifest.json (cor completa).
4. Folha de conferência assets_src/tex_raw/_preview.png com cada textura repetida 2x2 (emendas à vista).

Imagens brutas existentes são reaproveitadas (use --force para gerar de novo); --so-processar não chama o agy.

Uso:
  python tools/gen_detail_textures.py [--only reboco,telha] [--force] [--so-processar]
"""
from __future__ import annotations

import argparse
import json
import sys
import zlib
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gen_art  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SPEC = ROOT / "public" / "textures" / "detail.json"
MANIFEST = ROOT / "public" / "textures" / "manifest.json"
RAW = ROOT / "assets_src" / "tex_raw"
OUT_DETAIL = ROOT / "public" / "textures" / "detail"
OUT_TEX = ROOT / "public" / "textures"


@dataclass(frozen=True)
class Job:
    key: str
    prompt: str

    @property
    def raw_path(self) -> Path:
        return RAW / f"{self.key}.png"


def periodic_blur(a: np.ndarray, sigma: float) -> np.ndarray:
    """Desfoque gaussiano circular (a textura repete, então o desfoque também dá a volta)."""
    h, w = a.shape
    fy = np.fft.fftfreq(h)[:, None]
    fx = np.fft.fftfreq(w)[None, :]
    kernel = np.exp(-2 * (np.pi * sigma) ** 2 * (fx * fx + fy * fy))
    return np.real(np.fft.ifft2(np.fft.fft2(a) * kernel))


def make_seamless(img: np.ndarray, seed: int) -> np.ndarray:
    h, w = img.shape[:2]
    shifted = np.roll(np.roll(img, h // 2, axis=0), w // 2, axis=1)
    y = np.arange(h)[:, None]
    x = np.arange(w)[None, :]
    edge = np.minimum(np.minimum(x, w - 1 - x), np.minimum(y, h - 1 - y)) / (min(h, w) / 2)
    rng = np.random.default_rng(seed)
    noise = periodic_blur(rng.standard_normal((h, w)), 12.0)
    noise = (noise - noise.min()) / (np.ptp(noise) + 1e-9)
    t = np.clip((edge + (noise - 0.5) * 0.35 - 0.12) / 0.4, 0, 1)
    mask = (t * t * (3 - 2 * t))[..., None]
    return img * mask + shifted * (1 - mask)


def square(img: Image.Image, size: int) -> np.ndarray:
    side = min(img.size)
    left, top = (img.width - side) // 2, (img.height - side) // 2
    img = img.convert("RGB").crop((left, top, left + side, top + side)).resize((size, size), Image.LANCZOS)
    return np.asarray(img).astype(np.float64) / 255.0


def luminance(rgb: np.ndarray) -> np.ndarray:
    return rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722


def normal_xy(height: np.ndarray, strength: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Mesma convenção de public/textures/generate_textures.py (OpenGL, +Y para cima na imagem)."""
    dx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) * 0.5 * strength
    dy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) * 0.5 * strength
    nx, ny, nz = -dx, dy, np.ones_like(height)
    inv = 1.0 / np.sqrt(nx * nx + ny * ny + nz * nz)
    return nx * inv, ny * inv, nz * inv


def to8(a: np.ndarray) -> np.ndarray:
    return np.clip(a * 255.0 + 0.5, 0, 255).astype(np.uint8)


def process(key: str, spec: dict, size: int, kind: str) -> np.ndarray:
    work = make_seamless(square(Image.open(RAW / f"{key}.png"), size * 2), seed=zlib.crc32(key.encode()))
    rgb = np.asarray(Image.fromarray(to8(work)).resize((size, size), Image.LANCZOS)).astype(np.float64) / 255.0
    lum = luminance(rgb)
    # Relevo: luminância suavizada, sem o gradiente de baixa frequência (iluminação pintada não vira inclinação)
    height = periodic_blur(lum, 1.0) - periodic_blur(lum, 40.0)
    height = height / (np.abs(height).max() + 1e-9)
    nx, ny, nz = normal_xy(height, spec["normal"] * size / 512)
    base, var = spec["rugosidade"]
    rough = np.clip(base - (lum - lum.mean()) / (lum.std() + 1e-9) * var * 0.5, 0.04, 1.0)
    if kind == "camada":
        # Contraste normalizado: a imagem gerada pode vir lavada ou estourada; o detalhe gravado tem sempre
        # desvio-padrão 'contraste' em torno de 1 (cada camada pesa o mesmo na cor da paleta). Sem as manchas
        # de baixa frequência, que repetidas pela parede denunciam o ladrilhamento
        fine = lum - periodic_blur(lum, size / 12)
        detail = np.clip(1.0 + fine / (fine.std() + 1e-9) * spec["contraste"], 0.3, 1.7)
        packed = np.stack([nx * 0.5 + 0.5, ny * 0.5 + 0.5, np.clip(detail * 0.5, 0, 1)], axis=-1)
        OUT_DETAIL.mkdir(parents=True, exist_ok=True)
        Image.fromarray(to8(packed), "RGB").save(OUT_DETAIL / f"{key}.png", optimize=True)
    else:
        files = json.loads(MANIFEST.read_text(encoding="utf-8"))["sets"][spec["set"]]["files"]
        Image.fromarray(to8(rgb), "RGB").save(OUT_TEX / files["map"], optimize=True)
        Image.fromarray(to8(np.stack([nx, ny, nz], axis=-1) * 0.5 + 0.5), "RGB").save(OUT_TEX / files["normalMap"], optimize=True)
        Image.fromarray(to8(rough), "L").save(OUT_TEX / files["roughnessMap"], optimize=True)
    return rgb


def preview(tiles: dict[str, np.ndarray]) -> None:
    if not tiles:
        return
    cell = 256
    sheet = Image.new("RGB", (cell * 2 * len(tiles), cell * 2), (20, 20, 20))
    for i, (_key, rgb) in enumerate(tiles.items()):
        small = Image.fromarray(to8(rgb)).resize((cell, cell), Image.LANCZOS)
        for dy in (0, 1):
            for dx in (0, 1):
                sheet.paste(small, (i * cell * 2 + dx * cell, dy * cell))
    sheet.save(RAW / "_preview.png")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", default="")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--so-processar", action="store_true")
    ap.add_argument("--model", default="gemini-3.8-flash-low")
    ap.add_argument("--timeout", type=int, default=600)
    args = ap.parse_args()

    spec = json.loads(SPEC.read_text(encoding="utf-8"))
    size = int(spec["tamanho_px"])
    entries = [(c["id"], c, "camada") for c in spec["camadas"]] + [(c["set"], c, "chao") for c in spec["chao"]]
    only = {s.strip() for s in args.only.split(",") if s.strip()}
    entries = [e for e in entries if not only or e[0] in only]
    RAW.mkdir(parents=True, exist_ok=True)

    if not args.so_processar:
        for key, item, _kind in entries:
            job = Job(key, f"{spec['estilo']} {item['prompt']}")
            if job.raw_path.is_file() and not args.force:
                continue
            if gen_art.QUOTA.is_set():
                break
            ok = gen_art.run_agy(job, args.model, args.timeout)
            print(f"{'OK' if ok else 'FALHOU'} {key}", flush=True)
        if gen_art.QUOTA.is_set():
            print("cota de imagem do agy esgotada; rode de novo mais tarde (ou gere no Flow e salve em assets_src/tex_raw/<id>.png)")

    tiles: dict[str, np.ndarray] = {}
    missing = []
    for key, item, kind in entries:
        if not (RAW / f"{key}.png").is_file():
            missing.append(key)
            continue
        tiles[key] = process(key, item, size, kind)
        print(f"processado {key} ({kind})", flush=True)
    preview(tiles)
    if missing:
        print(f"faltam imagens brutas: {', '.join(missing)}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
