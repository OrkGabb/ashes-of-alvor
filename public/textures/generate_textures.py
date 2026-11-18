#!/usr/bin/env python3
"""
Gerador procedural de texturas PBR ladrilháveis para 'Cinzas de Alvor'.

Cada conjunto gera três mapas a partir do MESMO campo de altura (coerência PBR):
  <nome>_diff.png   Albedo (sRGB)
  <nome>_norm.png   Normal Map tangent-space (convenção OpenGL, +Y para cima)
  <nome>_rough.png  Roughness (linear, tons de cinza)

Ladrilhamento garantido por construção:
  - Ruído fractal via filtragem no domínio da frequência (FFT): o sinal é periódico.
  - Voronoi em grade com jitter e distâncias com wrap-around (toro).
  - Normais por diferenças finitas com np.roll (vizinhança circular).

Escala física: o 'manifest.json' grava quantos metros cada textura cobre (tile_m).
O gerador de cena (generate_assets.py) grava UVs em metros, então o app.js aplica
repeat = 1 / tile_m — densidade de texel idêntica em todas as superfícies.

Execução:
  python public/textures/generate_textures.py
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import numpy as np
from PIL import Image

TEXTURES_DIR = Path(__file__).resolve().parent
SIZE = 512


# ---------------------------------------------------------------------------
# Primitivas periódicas
# ---------------------------------------------------------------------------

def fft_noise(rng: np.random.Generator, size: int, scale_px: float, aniso: tuple[float, float] = (1.0, 1.0)) -> np.ndarray:
    """
    Ruído gaussiano filtrado no domínio da frequência; periódico e normalizado em [0, 1].
    aniso = (ax, ay): fator > 1 alonga as feições naquele eixo (atenua frequências ao longo dele).
    """
    white = rng.standard_normal((size, size))
    fy = np.fft.fftfreq(size)[:, None] * aniso[1]
    fx = np.fft.fftfreq(size)[None, :] * aniso[0]
    sigma = 1.0 / max(scale_px, 1e-3)
    gain = np.exp(-(fx * fx + fy * fy) / (2.0 * sigma * sigma))
    field = np.real(np.fft.ifft2(np.fft.fft2(white) * gain))
    field -= field.min()
    peak = field.max()
    return field / peak if peak > 0 else field


def fbm(rng: np.random.Generator, size: int, base_px: float, octaves: int, aniso: tuple[float, float] = (1.0, 1.0)) -> np.ndarray:
    total = np.zeros((size, size))
    amp, norm, scale = 1.0, 0.0, base_px
    for _ in range(octaves):
        total += fft_noise(rng, size, scale, aniso) * amp
        norm += amp
        amp *= 0.5
        scale *= 0.5
    return total / norm


def smoothstep(e0: float, e1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def periodic_voronoi(rng: np.random.Generator, size: int, cells: int, jitter: float = 0.85) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Voronoi em grade periódica (toro). Retorna F1, a distância EXATA até a aresta da célula
    (projeção sobre o bissetor com cada vizinho, em unidades de célula) e o id da célula.
    """
    pts = (rng.random((cells, cells, 2)) - 0.5) * jitter + 0.5
    coords = (np.arange(size) + 0.5) / size * cells
    gx, gy = np.meshgrid(coords, coords)
    cx = np.floor(gx).astype(int)
    cy = np.floor(gy).astype(int)
    offsets = [(ox, oy) for oy in (-2, -1, 0, 1, 2) for ox in (-2, -1, 0, 1, 2)]

    def feature(ox: int, oy: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        nx = cx + ox
        ny = cy + oy
        wx = np.mod(nx, cells)
        wy = np.mod(ny, cells)
        return nx + pts[wy, wx, 0], ny + pts[wy, wx, 1], wy * cells + wx

    f1 = np.full((size, size), 1e9)
    p1x = np.zeros((size, size))
    p1y = np.zeros((size, size))
    owner = np.zeros((size, size), dtype=np.int64)
    for ox, oy in offsets:
        px, py, cell_id = feature(ox, oy)
        d = np.hypot(gx - px, gy - py)
        closer = d < f1
        f1 = np.where(closer, d, f1)
        p1x = np.where(closer, px, p1x)
        p1y = np.where(closer, py, p1y)
        owner = np.where(closer, cell_id, owner)

    edge = np.full((size, size), 1e9)
    for ox, oy in offsets:
        px, py, _ = feature(ox, oy)
        ddx = px - p1x
        ddy = py - p1y
        length = np.hypot(ddx, ddy)
        valid = length > 1e-6
        safe = np.where(valid, length, 1.0)
        mx = (p1x + px) * 0.5 - gx
        my = (p1y + py) * 0.5 - gy
        border = (mx * ddx + my * ddy) / safe
        edge = np.where(valid, np.minimum(edge, border), edge)
    return f1, edge, owner


def cell_random(owner: np.ndarray, seed: int) -> np.ndarray:
    """Valor pseudo-aleatório estável por célula (hash inteiro)."""
    h = (owner.astype(np.uint64) * np.uint64(2654435761) + np.uint64(seed) * np.uint64(97531)) & np.uint64(0xFFFFFFFF)
    h ^= h >> np.uint64(15)
    h = (h * np.uint64(2246822519)) & np.uint64(0xFFFFFFFF)
    h ^= h >> np.uint64(13)
    return (h & np.uint64(0xFFFF)).astype(np.float64) / 65535.0


def height_to_normal(height: np.ndarray, strength: float) -> np.ndarray:
    """Normal tangent-space (OpenGL, +Y = para cima na imagem) por diferenças centrais circulares."""
    dx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) * 0.5 * strength
    dy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) * 0.5 * strength
    # Linha 0 da imagem é o topo: +V cresce para cima, então a derivada em V inverte o sinal.
    nx = -dx
    ny = dy
    nz = np.ones_like(height)
    inv = 1.0 / np.sqrt(nx * nx + ny * ny + nz * nz)
    rgb = np.stack([nx * inv, ny * inv, nz * inv], axis=-1) * 0.5 + 0.5
    return np.clip(rgb * 255.0 + 0.5, 0, 255).astype(np.uint8)


def to_rgb8(rgb: np.ndarray) -> np.ndarray:
    return np.clip(rgb * 255.0 + 0.5, 0, 255).astype(np.uint8)


def to_gray8(gray: np.ndarray) -> np.ndarray:
    return np.clip(gray * 255.0 + 0.5, 0, 255).astype(np.uint8)


def tint(base: tuple[float, float, float], shade: np.ndarray) -> np.ndarray:
    return np.stack([shade * base[0], shade * base[1], shade * base[2]], axis=-1)


@dataclass(frozen=True)
class PbrSet:
    albedo: np.ndarray   # float RGB [0, 1]
    height: np.ndarray   # float [0, 1]
    rough: np.ndarray    # float [0, 1]
    normal_strength: float


@dataclass(frozen=True)
class TextureSpec:
    name: str
    tile_m: float
    builder: Callable[[np.random.Generator], PbrSet]
    description: str


# ---------------------------------------------------------------------------
# Conjuntos de material
# ---------------------------------------------------------------------------

def build_cobble_wet(rng: np.random.Generator) -> PbrSet:
    """Pedras irregulares de calçamento; rejuntes encharcados (roughness baixa) e topo gasto."""
    f1, edge, owner = periodic_voronoi(rng, SIZE, cells=7, jitter=0.8)
    stone_mask = smoothstep(0.025, 0.075, edge)
    dome = 1.0 - np.clip(f1 / 0.75, 0.0, 1.0) ** 2 * 0.45
    grain = fbm(rng, SIZE, 10.0, 4)
    height = stone_mask * (0.55 + dome * 0.35) + grain * 0.10 * stone_mask
    height = np.clip(height, 0.0, 1.0)

    per_stone = cell_random(owner, 11)
    warm = cell_random(owner, 23)
    base = 0.30 + per_stone * 0.16 + (grain - 0.5) * 0.10
    albedo = np.stack([base * (0.84 + warm * 0.10), base * (0.88 + warm * 0.04), base * 0.98], axis=-1)
    mud = np.array([0.10, 0.09, 0.08])
    albedo = albedo * stone_mask[..., None] + mud * (1.0 - stone_mask[..., None])

    rough = 0.58 + per_stone * 0.12 + (grain - 0.5) * 0.12
    rough = rough * stone_mask + 0.22 * (1.0 - stone_mask)
    return PbrSet(albedo, height, np.clip(rough, 0.05, 1.0), normal_strength=5.5)


def build_plaster(rng: np.random.Generator) -> PbrSet:
    """Reboco de cal neutro (tingido por material no runtime) com manchas largas e grão fino."""
    blotch = fbm(rng, SIZE, 48.0, 3)
    fine = fbm(rng, SIZE, 3.0, 2)
    trowel = fft_noise(rng, SIZE, 20.0, aniso=(2.5, 0.7))
    height = blotch * 0.55 + fine * 0.25 + trowel * 0.20
    shade = 0.80 + (blotch - 0.5) * 0.16 + (fine - 0.5) * 0.06
    stain = smoothstep(0.62, 0.82, fbm(rng, SIZE, 70.0, 2)) * 0.10
    albedo = tint((0.93, 0.91, 0.87), shade - stain)
    rough = 0.86 + (fine - 0.5) * 0.10
    return PbrSet(albedo, height, np.clip(rough, 0.0, 1.0), normal_strength=2.2)


def build_timber(rng: np.random.Generator) -> PbrSet:
    """Carvalho envelhecido escuro: veio ao longo de U (eixo longo da viga), fendas finas."""
    grain = fbm(rng, SIZE, 6.0, 4, aniso=(14.0, 1.0))
    rings = np.sin(grain * 38.0) * 0.5 + 0.5
    cracks = smoothstep(0.80, 0.92, fft_noise(rng, SIZE, 2.0, aniso=(24.0, 1.0)))
    height = rings * 0.45 + grain * 0.45 - cracks * 0.55
    height = np.clip(height, 0.0, 1.0)
    shade = 0.55 + rings * 0.22 + (grain - 0.5) * 0.25 - cracks * 0.35
    albedo = tint((0.42, 0.29, 0.19), shade)
    rough = 0.72 + (1.0 - rings) * 0.10 + cracks * 0.15
    return PbrSet(albedo, height, np.clip(rough, 0.0, 1.0), normal_strength=3.4)


def build_planks(rng: np.random.Generator) -> PbrSet:
    """Tábuas corridas (piso, portas, cerca): 10 tábuas de 20 cm por tile, frestas escuras."""
    boards = 10
    v = (np.arange(SIZE) + 0.5) / SIZE * boards
    board_idx = np.floor(v).astype(int)
    pv = v - board_idx
    seam = np.minimum(pv, 1.0 - pv)
    seam_mask = smoothstep(0.015, 0.06, seam)[:, None] * np.ones((1, SIZE))
    # Desloca o veio por tábua para cada tábua ter desenho próprio
    grain = fbm(rng, SIZE, 5.0, 4, aniso=(16.0, 1.0))
    offsets = rng.integers(0, SIZE, size=boards)
    grain_rows = np.empty_like(grain)
    for b in range(boards):
        rows = board_idx == b
        grain_rows[rows] = np.roll(grain[rows], offsets[b], axis=1)
    board_tone = rng.random(boards)[board_idx][:, None] * np.ones((1, SIZE))
    height = seam_mask * (0.6 + grain_rows * 0.4)
    shade = (0.45 + grain_rows * 0.35 + board_tone * 0.18) * (0.35 + 0.65 * seam_mask)
    albedo = tint((0.56, 0.39, 0.25), shade)
    rough = 0.70 + (1.0 - grain_rows) * 0.12 + (1.0 - seam_mask) * 0.15
    return PbrSet(albedo, height, np.clip(rough, 0.0, 1.0), normal_strength=3.0)


def build_roof_tiles(rng: np.random.Generator) -> PbrSet:
    """Telhas planas sobrepostas em fiadas desencontradas; tingidas por material (barro/ardósia)."""
    rows, cols = 8, 8
    yy, xx = np.meshgrid((np.arange(SIZE) + 0.5) / SIZE, (np.arange(SIZE) + 0.5) / SIZE, indexing="ij")
    row_f = yy * rows
    row = np.floor(row_f).astype(int)
    fv = row_f - row
    col_f = xx * cols + (row % 2) * 0.5
    col = np.floor(col_f).astype(int) % cols
    fu = col_f - np.floor(col_f)
    tile_id = row * cols + col
    jitter = cell_random(tile_id, 5)
    # Imagem: linha 0 no topo; a borda inferior de cada telha (fv -> 1) fica saliente
    slope = fv
    gap_u = smoothstep(0.0, 0.05, np.minimum(fu, 1.0 - fu))
    lip = smoothstep(0.0, 0.08, 1.0 - fv)
    bulge = 1.0 - (fu - 0.5) ** 2 * 1.2
    noise = fbm(rng, SIZE, 6.0, 3)
    height = (0.25 + slope * 0.6 * lip) * gap_u * bulge + noise * 0.08
    height = np.clip(height, 0.0, 1.0)
    shade = (0.62 + jitter * 0.30 + (noise - 0.5) * 0.15) * (0.45 + 0.55 * gap_u) * (0.30 + 0.70 * fv ** 0.6) * (0.6 + 0.4 * lip)
    albedo = tint((0.86, 0.84, 0.82), shade)
    rough = 0.55 + (1.0 - jitter) * 0.15 + (1.0 - gap_u) * 0.2
    return PbrSet(albedo, height, np.clip(rough, 0.0, 1.0), normal_strength=4.0)


def build_stone_masonry(rng: np.random.Generator) -> PbrSet:
    """Alvenaria de pedra em fiadas horizontais (fundações, lareira, chaminé)."""
    course_heights = rng.uniform(0.16, 0.24, size=12)
    course_heights = course_heights / course_heights.sum()
    edges = np.concatenate([[0.0], np.cumsum(course_heights)])
    v = (np.arange(SIZE) + 0.5) / SIZE
    u = (np.arange(SIZE) + 0.5) / SIZE
    course = np.clip(np.searchsorted(edges, v, side="right") - 1, 0, len(course_heights) - 1)
    fv = (v - edges[course]) / course_heights[course]
    height = np.zeros((SIZE, SIZE))
    block_tone = np.zeros((SIZE, SIZE))
    for c in range(len(course_heights)):
        rows = course == c
        widths = rng.uniform(0.18, 0.34, size=10)
        widths = widths / widths.sum()
        bedges = np.concatenate([[0.0], np.cumsum(widths)])
        shift = rng.random()
        uu = np.mod(u + shift, 1.0)
        blk = np.clip(np.searchsorted(bedges, uu, side="right") - 1, 0, len(widths) - 1)
        fu = (uu - bedges[blk]) / widths[blk]
        joint_u = smoothstep(0.0, 0.07, np.minimum(fu, 1.0 - fu))
        joint_v = smoothstep(0.0, 0.09, np.minimum(fv[rows], 1.0 - fv[rows]))[:, None]
        mask = joint_v * joint_u[None, :]
        height[rows] = mask
        block_tone[rows] = (rng.random(len(widths))[blk])[None, :] * np.ones((rows.sum(), 1))
    rough_face = fbm(rng, SIZE, 7.0, 4)
    face = height * (0.65 + rough_face * 0.35)
    shade = (0.42 + block_tone * 0.22 + (rough_face - 0.5) * 0.18) * (0.35 + 0.65 * height)
    albedo = tint((0.86, 0.84, 0.80), shade)
    rough = 0.78 + (rough_face - 0.5) * 0.15 + (1.0 - height) * 0.12
    return PbrSet(albedo, np.clip(face, 0.0, 1.0), np.clip(rough, 0.0, 1.0), normal_strength=5.0)


def build_ground(rng: np.random.Generator) -> PbrSet:
    """Terra lamacenta com tufos de grama baixa ao redor da vila."""
    base = fbm(rng, SIZE, 40.0, 4)
    grass = smoothstep(0.45, 0.65, fbm(rng, SIZE, 26.0, 3))
    blades = fft_noise(rng, SIZE, 1.2)
    height = base * 0.6 + grass * blades * 0.4
    mud = tint((0.34, 0.27, 0.20), 0.55 + base * 0.45)
    turf = tint((0.22, 0.30, 0.15), 0.6 + blades * 0.4)
    albedo = mud * (1.0 - grass[..., None]) + turf * grass[..., None]
    rough = 0.62 * (1.0 - grass) + 0.88 * grass + (base - 0.5) * 0.1
    return PbrSet(albedo, height, np.clip(rough, 0.0, 1.0), normal_strength=3.0)


TEXTURE_SPECS: tuple[TextureSpec, ...] = (
    TextureSpec("cobble_wet", 2.4, build_cobble_wet, "Calçamento molhado da praça (poças vêm do shader)"),
    TextureSpec("plaster", 2.0, build_plaster, "Reboco de cal neutro, tingido por material"),
    TextureSpec("timber", 1.6, build_timber, "Vigas de carvalho, veio ao longo de U"),
    TextureSpec("planks", 2.0, build_planks, "Tábuas de piso, portas e cercas"),
    TextureSpec("roof_tiles", 2.0, build_roof_tiles, "Telhas sobrepostas, tingidas por material"),
    TextureSpec("stone", 2.0, build_stone_masonry, "Alvenaria de pedra em fiadas"),
    TextureSpec("ground", 4.0, build_ground, "Terra e grama do entorno"),
)


def write_set(spec: TextureSpec, seed: int) -> dict[str, object]:
    rng = np.random.default_rng(seed)
    pbr = spec.builder(rng)
    files = {
        "map": f"{spec.name}_diff.png",
        "normalMap": f"{spec.name}_norm.png",
        "roughnessMap": f"{spec.name}_rough.png",
    }
    Image.fromarray(to_rgb8(pbr.albedo), "RGB").save(TEXTURES_DIR / files["map"], optimize=True)
    Image.fromarray(height_to_normal(pbr.height, pbr.normal_strength), "RGB").save(TEXTURES_DIR / files["normalMap"], optimize=True)
    Image.fromarray(to_gray8(pbr.rough), "L").save(TEXTURES_DIR / files["roughnessMap"], optimize=True)
    return {"tile_m": spec.tile_m, "files": files, "description": spec.description}


def main() -> None:
    manifest: dict[str, object] = {"size_px": SIZE, "uv_unit": "meter", "sets": {}}
    sets: dict[str, object] = manifest["sets"]  # type: ignore[assignment]
    for i, spec in enumerate(TEXTURE_SPECS):
        sets[spec.name] = write_set(spec, seed=1000 + i * 17)
        total_kb = sum((TEXTURES_DIR / f).stat().st_size for f in sets[spec.name]["files"].values()) / 1024.0  # type: ignore[index]
        print(f"[OK] {spec.name:<11} tile={spec.tile_m:.1f} m  {total_kb:7.1f} KB")
    (TEXTURES_DIR / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[OK] manifest.json com {len(sets)} conjuntos em {TEXTURES_DIR}")


if __name__ == "__main__":
    main()
