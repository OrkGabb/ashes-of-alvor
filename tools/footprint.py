#!/usr/bin/env python3
"""
Pegada real dos modelos na altura do corpo (fonte única para colisores e para o teste de barreiras).

O AABB do modelo inteiro inclui copa de árvore, toldo de barraca e beiral: virar isso colisor cria
barreira invisível. Aqui a geometria é amostrada na superfície dos triângulos, transformada para o
mundo com a mesma matriz do navegador (posição, rotação Y, escala por eixo) e só os pontos dentro
da faixa do corpo (BODY_LO..BODY_HI) contam. O resultado é uma grade de ocupação em XZ.
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np

from gltf_bounds import Gltf

BODY_LO = 0.22          # acima disso o pé não passa (meio-fio e tapetes ficam de fora)
BODY_HI = 1.5           # abaixo disso o tronco bate (beirais e copas ficam de fora)
_SAMPLES: dict[str, np.ndarray] = {}


WORLD_STEP = 0.07      # espaçamento das amostras no mundo (a grade de colisão é de 0,2 m)
_TRIS: dict[str, np.ndarray] = {}


def model_samples(path: Path | str, step: float) -> np.ndarray:
    """Pontos (N, 3) na superfície do modelo, em coordenadas do modelo, espaçados ~'step' unidades do modelo."""
    key = f"{path}|{step:.4f}"
    if key in _SAMPLES:
        return _SAMPLES[key]
    if str(path) not in _TRIS:
        _TRIS[str(path)] = Gltf(Path(path)).triangles_world()
    tris = _TRIS[str(path)]
    if not len(tris):
        _SAMPLES[key] = np.zeros((0, 3))
        return _SAMPLES[key]
    a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
    longest = np.maximum(np.maximum(np.linalg.norm(b - a, axis=1), np.linalg.norm(c - b, axis=1)), np.linalg.norm(a - c, axis=1))
    n = np.clip(np.ceil(longest / step).astype(int), 1, 60)
    pts = [tris.reshape(-1, 3)]
    for k in np.unique(n):
        if k <= 1:
            continue
        sel = n == k
        u, v = np.meshgrid(np.arange(k + 1), np.arange(k + 1), indexing="ij")
        keep = (u + v) <= k
        u = u[keep] / k
        v = v[keep] / k
        pa, pb, pc = a[sel][:, None, :], b[sel][:, None, :], c[sel][:, None, :]
        p = pa + (pb - pa) * u[None, :, None] + (pc - pa) * v[None, :, None]
        pts.append(p.reshape(-1, 3))
    out = np.concatenate(pts)
    _SAMPLES[key] = out
    return out


def instance_points(path: Path | str, inst: dict) -> np.ndarray:
    """Pontos do modelo no mundo com a transformação da instância (mesma composição do world.js)."""
    s = inst["s"]
    sx, sy, sz = (s, s, s) if not isinstance(s, list) else s
    step = WORLD_STEP / max(abs(sx), abs(sy), abs(sz), 1e-3)
    pts = model_samples(path, round(step, 4))
    r = inst.get("r", 0.0)
    c, si = math.cos(r), math.sin(r)
    lx, ly, lz = pts[:, 0] * sx, pts[:, 1] * sy, pts[:, 2] * sz
    x = inst["p"][0] + lx * c + lz * si
    z = inst["p"][2] - lx * si + lz * c
    y = inst["p"][1] + ly
    return np.stack([x, y, z], axis=1)


def body_points(path: Path | str, inst: dict, lo: float = BODY_LO, hi: float = BODY_HI) -> np.ndarray:
    p = instance_points(path, inst)
    return p[(p[:, 1] >= lo) & (p[:, 1] <= hi)]


def footprint_boxes(points: np.ndarray, cell: float = 0.12, pad: float = 0.0, max_boxes: int = 14) -> list[tuple[float, float, float, float]]:
    """Retângulos (x0, z0, x1, z1) que cobrem a ocupação de 'points' numa grade de 'cell' metros.

    Fusão gulosa linha a linha; se sobrar retângulo demais, a resolução cai até caber em max_boxes.
    """
    if not len(points):
        return []
    while True:
        x0, z0 = points[:, 0].min(), points[:, 2].min()
        i = np.floor((points[:, 0] - x0) / cell).astype(int)
        j = np.floor((points[:, 2] - z0) / cell).astype(int)
        occ = np.zeros((i.max() + 1, j.max() + 1), dtype=bool)
        occ[i, j] = True
        occ = _fill_holes(occ)
        boxes = _greedy_rects(occ)
        if len(boxes) <= max_boxes or cell > 2.0:
            break
        cell *= 1.5
    nx, nz = occ.shape
    out = []
    for a, b, c, d in boxes:
        # Borda exposta (sem vizinho ocupado do outro lado) encosta nos pontos reais; borda interna
        # (encostada em outro retângulo ou no miolo preenchido) fica na grade para não abrir fresta.
        ex0, ez0, ex1, ez1 = x0 + a * cell, z0 + b * cell, x0 + c * cell, z0 + d * cell
        inside = (i >= a) & (i < c) & (j >= b) & (j < d)
        p = points[inside]
        if len(p):
            if a == 0 or not occ[a - 1, b:d].any():
                ex0 = p[:, 0].min()
            if c == nx or not occ[c, b:d].any():
                ex1 = p[:, 0].max()
            if b == 0 or not occ[a:c, b - 1].any():
                ez0 = p[:, 2].min()
            if d == nz or not occ[a:c, d].any():
                ez1 = p[:, 2].max()
        out.append((ex0 - pad, ez0 - pad, max(ex1, ex0 + 0.04) + pad, max(ez1, ez0 + 0.04) + pad))
    return out


def _fill_holes(occ: np.ndarray) -> np.ndarray:
    """Interior oco (pilar, poço, barril amostrados só na casca) vira sólido: ninguém deve entrar nele."""
    from collections import deque
    nx, nz = occ.shape
    outside = np.zeros((nx + 2, nz + 2), dtype=bool)
    grid = np.zeros((nx + 2, nz + 2), dtype=bool)
    grid[1:-1, 1:-1] = occ
    q = deque([(0, 0)])
    outside[0, 0] = True
    while q:
        a, b = q.popleft()
        for da, db in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            na, nb = a + da, b + db
            if 0 <= na < nx + 2 and 0 <= nb < nz + 2 and not outside[na, nb] and not grid[na, nb]:
                outside[na, nb] = True
                q.append((na, nb))
    return ~outside[1:-1, 1:-1]


def _greedy_rects(occ: np.ndarray) -> list[tuple[int, int, int, int]]:
    occ = occ.copy()
    rects = []
    nx, nz = occ.shape
    for i in range(nx):
        j = 0
        while j < nz:
            if not occ[i, j]:
                j += 1
                continue
            j1 = j
            while j1 < nz and occ[i, j1]:
                j1 += 1
            i1 = i + 1
            while i1 < nx and occ[i1, j:j1].all():
                i1 += 1
            occ[i:i1, j:j1] = False
            rects.append((i, j, i1, j1))
            j = j1
    return rects
