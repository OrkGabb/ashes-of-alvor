#!/usr/bin/env python3
"""
Leitura mínima de glTF/GLB (sem dependências além de numpy) para o pipeline da cidade.

- bounds(path): AABB do modelo em coordenadas glTF (Y para cima), com as transformações dos nós
  aplicadas, a partir dos min/max dos acessores POSITION (não depende de varrer vértices).
- triangles(path): quantidade de triângulos que a GPU vai desenhar.
- vertices_world(path): vértices em mundo (usado por testes que medem geometria real).
"""
from __future__ import annotations

import json
import struct
from pathlib import Path

import numpy as np

_COMPONENTS = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
_WIDTH = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def _quat_matrix(q: list[float]) -> np.ndarray:
    x, y, z, w = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def node_matrix(nd: dict) -> np.ndarray:
    if "matrix" in nd:
        return np.array(nd["matrix"], dtype=float).reshape(4, 4).T
    m = np.eye(4)
    s = np.array(nd.get("scale", [1, 1, 1]), dtype=float)
    m[:3, :3] = _quat_matrix(nd.get("rotation", [0, 0, 0, 1])) * s
    m[:3, 3] = nd.get("translation", [0, 0, 0])
    return m


class Gltf:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        raw = self.path.read_bytes()
        self.buffers: list[bytes] = []
        if raw[:4] == b"glTF":
            json_len = struct.unpack_from("<I", raw, 12)[0]
            self.json = json.loads(raw[20:20 + json_len])
            off = 20 + json_len
            if off < len(raw):
                bin_len = struct.unpack_from("<I", raw, off)[0]
                self.buffers.append(raw[off + 8: off + 8 + bin_len])
        else:
            self.json = json.loads(raw.decode("utf-8"))
            for buf in self.json.get("buffers", []):
                self.buffers.append((self.path.parent / buf["uri"]).read_bytes())

    def accessor(self, index: int) -> np.ndarray:
        acc = self.json["accessors"][index]
        view = self.json["bufferViews"][acc["bufferView"]]
        data = self.buffers[view.get("buffer", 0)]
        dtype = np.dtype(_COMPONENTS[acc["componentType"]])
        width = _WIDTH[acc["type"]]
        start = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
        stride = view.get("byteStride", 0) or dtype.itemsize * width
        count = acc["count"]
        buf = np.frombuffer(data, dtype=np.uint8, count=stride * (count - 1) + dtype.itemsize * width, offset=start)
        out = np.lib.stride_tricks.as_strided(buf, shape=(count, dtype.itemsize * width), strides=(stride, 1)).copy()
        return out.view(dtype).reshape(count, width)

    def mesh_nodes(self):
        """(matriz de mundo, índice de malha) de cada nó com malha, percorrendo a cena padrão."""
        nodes = self.json.get("nodes", [])
        scene = self.json.get("scenes", [{}])[self.json.get("scene", 0)]
        stack = [(i, np.eye(4)) for i in scene.get("nodes", range(len(nodes)))]
        while stack:
            idx, parent = stack.pop()
            nd = nodes[idx]
            world = parent @ node_matrix(nd)
            if "mesh" in nd and "skin" not in nd:
                yield world, nd["mesh"]
            for c in nd.get("children", []):
                stack.append((c, world))

    def bounds(self) -> tuple[np.ndarray, np.ndarray]:
        lo = np.full(3, np.inf)
        hi = np.full(3, -np.inf)
        for world, mi in self.mesh_nodes():
            for prim in self.json["meshes"][mi]["primitives"]:
                acc = self.json["accessors"][prim["attributes"]["POSITION"]]
                amin, amax = np.array(acc["min"], dtype=float), np.array(acc["max"], dtype=float)
                corners = np.array([[x, y, z, 1.0] for x in (amin[0], amax[0]) for y in (amin[1], amax[1]) for z in (amin[2], amax[2])])
                w = corners @ world.T
                lo = np.minimum(lo, w[:, :3].min(0))
                hi = np.maximum(hi, w[:, :3].max(0))
        return lo, hi

    def triangles(self) -> int:
        total = 0
        for _world, mi in self.mesh_nodes():
            for prim in self.json["meshes"][mi]["primitives"]:
                if "indices" in prim:
                    total += self.json["accessors"][prim["indices"]]["count"] // 3
                else:
                    total += self.json["accessors"][prim["attributes"]["POSITION"]]["count"] // 3
        return total

    def triangles_world(self) -> np.ndarray:
        parts = []
        for world, mi in self.mesh_nodes():
            for prim in self.json["meshes"][mi]["primitives"]:
                pos = self.accessor(prim["attributes"]["POSITION"]).astype(float)
                idx = self.accessor(prim["indices"]).reshape(-1).astype(np.int64) if "indices" in prim else np.arange(len(pos))
                w = np.c_[pos, np.ones(len(pos))] @ world.T
                parts.append(w[idx.reshape(-1, 3), :3])
        return np.concatenate(parts) if parts else np.zeros((0, 3, 3))


def bounds(path: Path) -> tuple[np.ndarray, np.ndarray]:
    return Gltf(path).bounds()


if __name__ == "__main__":
    import sys

    for p in sys.argv[1:]:
        g = Gltf(Path(p))
        lo, hi = g.bounds()
        print(f"{Path(p).name:42s} lo=({lo[0]:6.2f},{lo[1]:6.2f},{lo[2]:6.2f}) hi=({hi[0]:6.2f},{hi[1]:6.2f},{hi[2]:6.2f}) tris={g.triangles()}")
