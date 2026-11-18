"""
Conferência visual (Blender headless) do que o build_city.py montou: lê public/assets/city/city.json,
instancia cada modelo exatamente com a transformação que o navegador vai usar e renderiza vistas.

Uso:
  blender -b -P tools/preview_city.py -- <saida_prefixo> [cx cz alcance] [--filtro texto]
    cx/cz/alcance: recorte do mapa (metros) para focar num trecho; omitido = cidade inteira.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Euler, Matrix, Vector

ROOT = Path(__file__).resolve().parent.parent
CITY = ROOT / "public" / "assets" / "city" / "city.json"

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
out_prefix = argv[0] if argv else str(ROOT / "preview")
focus = [float(v) for v in argv[1:4]] if len(argv) >= 4 and not argv[1].startswith("--") else None
name_filter = argv[argv.index("--filtro") + 1] if "--filtro" in argv else ""

bpy.ops.wm.read_factory_settings(use_empty=True)
city = json.loads(CITY.read_text(encoding="utf-8"))
models = city["models"]
cache: dict[str, list[bpy.types.Object]] = {}
hidden = bpy.data.collections.new("protos")
bpy.context.scene.collection.children.link(hidden)
hidden.hide_render = True


def proto(key: str) -> list[bpy.types.Object]:
    if key in cache:
        return cache[key]
    path = ROOT / "public" / models[key]["url"].lstrip("./")
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(path))
    new = [o for o in bpy.data.objects if o not in before]
    meshes = []
    for o in new:
        for c in o.users_collection:
            c.objects.unlink(o)
        hidden.objects.link(o)
        if o.type == "MESH":
            meshes.append(o)
    cache[key] = meshes
    return meshes


# glTF (Y para cima, -Z frente) -> Blender (Z para cima): x, -z, y
def to_blender(p):
    return Vector((p[0], -p[2], p[1]))


count = 0
for inst in city["instances"]:
    if name_filter and name_filter not in inst.get("tag", ""):
        continue
    x, y, z = inst["p"]
    if focus and (abs(x - focus[0]) > focus[2] or abs(z - focus[1]) > focus[2]):
        continue
    s = inst.get("s", 1.0)
    sx, sy, sz = s if isinstance(s, list) else (s, s, s)
    rot = inst.get("r", 0.0)
    # Escala em eixos glTF (x, y, z) -> Blender (x, -z, y)
    m_world = Matrix.Translation(to_blender((x, y, z))) @ Matrix.Rotation(rot, 4, "Z") @ Matrix.Diagonal((sx, sz, sy, 1.0))
    for src in proto(inst["m"]):
        o = src.copy()
        bpy.context.scene.collection.objects.link(o)
        o.matrix_world = m_world @ src.matrix_world
        count += 1
print(f"[preview] {count} objetos instanciados")

scene = bpy.context.scene
engines = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
scene.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in engines else "BLENDER_EEVEE"
scene.render.resolution_x, scene.render.resolution_y = 1400, 900
world = bpy.data.worlds.new("W")
scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.55, 0.62, 0.72, 1)
world.node_tree.nodes["Background"].inputs[1].default_value = 0.9
sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN"))
sun.data.energy = 3.0
sun.rotation_euler = (math.radians(48), 0, math.radians(35))
scene.collection.objects.link(sun)
cam = bpy.data.objects.new("Cam", bpy.data.cameras.new("Cam"))
scene.collection.objects.link(cam)
scene.camera = cam
cam.data.clip_end = 2000

if focus:
    c = to_blender((focus[0], 0.0, focus[1]))
    span = focus[2]
else:
    b = city["bounds"]
    c = to_blender(((b["minX"] + b["maxX"]) * 0.5, 0.0, (b["minZ"] + b["maxZ"]) * 0.5))
    span = max(b["maxX"] - b["minX"], b["maxZ"] - b["minZ"]) * 0.5

views = {
    "sul": Vector((0.0, -1.0, 0.62)),
    "leste": Vector((1.0, -0.25, 0.55)),
    "topo": Vector((0.0, -0.05, 1.0)),
}
for name, d in views.items():
    cam.location = c + d.normalized() * span * 2.3
    cam.rotation_euler = (c - cam.location).to_track_quat("-Z", "Y").to_euler()
    cam.data.lens = 32
    scene.render.filepath = f"{out_prefix}_{name}.png"
    bpy.ops.render.render(write_still=True)
    print("[preview]", scene.render.filepath)
