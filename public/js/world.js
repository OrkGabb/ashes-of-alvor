import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { CONFIG, QUALITY, fetchJson } from "./config.js";
import { buildInteriors } from "./interiors.js";

// Mundo montado a partir de assets/city/city.json (tools/build_city.py é a fonte única do layout).
// A geometria estática é fundida por material e por bloco do mapa: poucos draw calls, frustum
// culling por bloco. Instâncias marcadas 'dyn' (coletáveis, adereços que somem) ficam soltas.

const DETAIL_KITS = new Set(["dungeon", "adv", "pets"]);
const DETAIL_TAGS = new Set(["bush", "stall", "cart", "lamp", "yard_fence", "well", "inn_sign"]);
const INSTANCED_TAGS = new Set(["forest", "tree", "bush", "rock"]);
const _m = new THREE.Matrix4();
const _n = new THREE.Matrix3();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _tmpBox = new THREE.Box3();
const UP = new THREE.Vector3(0, 1, 0);

export function containsXZ(box, x, z) {
  return x >= box.minX && x <= box.maxX && z >= box.minZ && z <= box.maxZ;
}

// Grade espacial 2D (células de 8 m) para consultas de colisão sem alocação por frame
class SpatialGrid {
  constructor(items, cellSize = 8) {
    this.cellSize = cellSize;
    this.invCell = 1 / cellSize;
    this.originX = 0;
    this.originZ = 0;
    this.nx = 0;
    this.nz = 0;
    this.cells = [];
    this._nearOut = [];
    this._nearStamp = 0;
    this._rayOut = [];
    this._rayStamp = 0;
    if (!items || !items.length) return;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < items.length; i++) {
      const c = items[i];
      if (c.minX < minX) minX = c.minX;
      if (c.maxX > maxX) maxX = c.maxX;
      if (c.minZ < minZ) minZ = c.minZ;
      if (c.maxZ > maxZ) maxZ = c.maxZ;
    }
    this.originX = Math.floor(minX * this.invCell) * cellSize;
    this.originZ = Math.floor(minZ * this.invCell) * cellSize;
    this.nx = Math.floor((maxX - this.originX) * this.invCell) + 1;
    this.nz = Math.floor((maxZ - this.originZ) * this.invCell) + 1;
    this.cells = new Array(this.nx * this.nz);
    for (let i = 0; i < items.length; i++) {
      const c = items[i];
      c.queryStamp = 0;
      c.rayQueryStamp = 0;
      const ix0 = Math.max(0, Math.floor((c.minX - this.originX) * this.invCell));
      const ix1 = Math.min(this.nx - 1, Math.floor((c.maxX - this.originX) * this.invCell));
      const iz0 = Math.max(0, Math.floor((c.minZ - this.originZ) * this.invCell));
      const iz1 = Math.min(this.nz - 1, Math.floor((c.maxZ - this.originZ) * this.invCell));
      for (let iz = iz0; iz <= iz1; iz++) {
        const row = iz * this.nx;
        for (let ix = ix0; ix <= ix1; ix++) {
          let bucket = this.cells[row + ix];
          if (!bucket) {
            bucket = [];
            this.cells[row + ix] = bucket;
          }
          bucket.push(c);
        }
      }
    }
  }

  _collect(minX, minZ, maxX, maxZ, out, stampKey, stamp) {
    out.length = 0;
    if (!this.nx) return out;
    const ix0 = Math.max(0, Math.floor((minX - this.originX) * this.invCell));
    const ix1 = Math.min(this.nx - 1, Math.floor((maxX - this.originX) * this.invCell));
    const iz0 = Math.max(0, Math.floor((minZ - this.originZ) * this.invCell));
    const iz1 = Math.min(this.nz - 1, Math.floor((maxZ - this.originZ) * this.invCell));
    if (ix0 > ix1 || iz0 > iz1) return out;
    for (let iz = iz0; iz <= iz1; iz++) {
      const row = iz * this.nx;
      for (let ix = ix0; ix <= ix1; ix++) {
        const bucket = this.cells[row + ix];
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const c = bucket[i];
          if (c[stampKey] !== stamp) {
            c[stampKey] = stamp;
            out.push(c);
          }
        }
      }
    }
    return out;
  }

  queryNear(x, z, radius = 4) {
    return this._collect(x - radius, z - radius, x + radius, z + radius, this._nearOut, "queryStamp", ++this._nearStamp);
  }

  queryRay(x0, z0, x1, z1) {
    return this._collect(
      Math.min(x0, x1) - 1.0,
      Math.min(z0, z1) - 1.0,
      Math.max(x0, x1) + 1.0,
      Math.max(z0, z1) + 1.0,
      this._rayOut,
      "rayQueryStamp",
      ++this._rayStamp
    );
  }
}

export class WorldIndex {
  constructor(city) {
    this.city = city;
    this.colliders = city.colliders;
    this.spatial = new SpatialGrid(this.colliders, 8);
    this.zones = [...city.zones].sort((a, b) => b.priority - a.priority);
    this.roofs = city.roofs;
    this.lights = city.lights.map((l) => ({
      ...l,
      position: new THREE.Vector3(...l.p),
      color: new THREE.Color(l.color),
    }));
    this.glows = city.glows;
    this.anchors = {};
    for (const [k, a] of Object.entries(city.anchors)) this.anchors[k] = { ...a, position: new THREE.Vector3(...a.p) };
    this.collectibles = city.collectibles;
    this.interactables = city.interactables;
    this.nav = city.nav;
    this.bounds = city.walk;
    this.spawn = city.spawn;
    this.dyn = new Map();
    this.defaultZone = { key: "Cidade", name: "Cinzas de Alvor", sub: "Capital da Marca de Alvor", building: false, floorY: 0, cameraClamp: false, priority: -1 };
    this.marcoZones = this.zones.filter((z) => z.marco);
    this.fires = [];
  }

  collidersNear(x, z, radius = 4) {
    return this.spatial.queryNear(x, z, radius);
  }

  rayColliders(x0, z0, x1, z1) {
    return this.spatial.queryRay(x0, z0, x1, z1);
  }

  zoneAt(x, z) {
    const zones = this.zones;
    for (let i = 0; i < zones.length; i++) {
      if (containsXZ(zones[i], x, z)) return zones[i];
    }
    return this.defaultZone;
  }

  marcoAt(x, z) {
    for (let i = 0; i < this.marcoZones.length; i++) {
      if (containsXZ(this.marcoZones[i], x, z)) return this.marcoZones[i].marco;
    }
    return null;
  }

  underRoof(x, z, margin = 0) {
    for (let i = 0; i < this.roofs.length; i++) {
      const r = this.roofs[i];
      if (x >= r.minX - margin && x <= r.maxX + margin && z >= r.minZ - margin && z <= r.maxZ + margin) return true;
    }
    return false;
  }

  dynObjects(key) {
    return this.dyn.get(key) || [];
  }

  setDynVisible(key, visible) {
    for (const o of this.dynObjects(key)) o.visible = visible;
  }
}

// --------------------------------------------------------------------------------------------
// Materiais canônicos por kit (um por textura): é o que permite fundir milhares de instâncias
// --------------------------------------------------------------------------------------------
class KitMaterials {
  constructor(city, library) {
    this.city = city;
    this.library = library;
    this.loader = new THREE.TextureLoader();
    this.byKey = new Map();
    this.paletteTex = new Map();
  }

  palette(pal) {
    const name = pal && this.city.palettes[pal] ? pal : "base";
    if (!this.paletteTex.has(name)) {
      const tex = this.loader.load(this.city.palettes[name]);
      tex.flipY = false;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      this.paletteTex.set(name, tex);
    }
    return this.paletteTex.get(name);
  }

  get(kit, srcMaterial, pal) {
    const isWater = /water/i.test(srcMaterial.name || "");
    const key = isWater ? "water" : kit === "kenney" ? `kenney|${pal || "base"}` : `${kit}|${srcMaterial.name}`;
    if (this.byKey.has(key)) return { key, material: this.byKey.get(key) };
    let material;
    if (isWater) {
      material = new THREE.MeshStandardMaterial({ color: 0x3a78a8, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.86, envMapIntensity: 1.4 });
      this.library.enableWater(material);
    } else if (kit === "kenney") {
      material = new THREE.MeshStandardMaterial({ map: this.palette(pal), roughness: 0.84, metalness: 0, side: THREE.DoubleSide });
      if (QUALITY.surfaceDetail > 0) this.library.enableSurfaceDetail(material);
    } else {
      material = new THREE.MeshStandardMaterial({ map: srcMaterial.map || null, color: srcMaterial.map ? 0xffffff : srcMaterial.color, roughness: 0.8, metalness: 0 });
      if (srcMaterial.map) srcMaterial.map.anisotropy = 4;
      // Atlas KayKit Dungeon com classe no alfa (pedra da muralha, madeira dos móveis): mesmo detalhe das casas
      if (kit === "dungeon" && srcMaterial.map && QUALITY.surfaceDetail > 0) this.library.enableSurfaceDetail(material);
    }
    material.name = key;
    this.byKey.set(key, material);
    return { key, material };
  }
}

// --------------------------------------------------------------------------------------------
// Fusão manual de geometrias (posição, normal, uv) com matriz por instância
// --------------------------------------------------------------------------------------------
class Bucket {
  constructor(material, cast) {
    this.material = material;
    this.cast = cast;
    this.parts = [];
    this.vertices = 0;
    this.indices = 0;
  }

  add(geometry, matrix) {
    const count = geometry.attributes.position.count;
    const idx = geometry.index ? geometry.index.count : count;
    this.parts.push({ geometry, matrix: matrix.clone(), flip: matrix.determinant() < 0 });
    this.vertices += count;
    this.indices += idx;
  }

  build() {
    const pos = new Float32Array(this.vertices * 3);
    const nor = new Float32Array(this.vertices * 3);
    const uv = new Float32Array(this.vertices * 2);
    const index = this.vertices > 65535 ? new Uint32Array(this.indices) : new Uint16Array(this.indices);
    let vo = 0;
    let io = 0;
    for (const { geometry, matrix, flip } of this.parts) {
      const P = geometry.attributes.position;
      const N = geometry.attributes.normal;
      const U = geometry.attributes.uv;
      _n.getNormalMatrix(matrix);
      for (let i = 0; i < P.count; i++) {
        _v.fromBufferAttribute(P, i).applyMatrix4(matrix);
        pos[(vo + i) * 3] = _v.x;
        pos[(vo + i) * 3 + 1] = _v.y;
        pos[(vo + i) * 3 + 2] = _v.z;
        if (N) {
          _v.fromBufferAttribute(N, i).applyMatrix3(_n).normalize();
          nor[(vo + i) * 3] = _v.x;
          nor[(vo + i) * 3 + 1] = _v.y;
          nor[(vo + i) * 3 + 2] = _v.z;
        }
        if (U) {
          uv[(vo + i) * 2] = U.getX(i);
          uv[(vo + i) * 2 + 1] = U.getY(i);
        }
      }
      const I = geometry.index;
      const n = I ? I.count : P.count;
      for (let t = 0; t < n; t += 3) {
        const a = I ? I.getX(t) : t;
        const b = I ? I.getX(t + 1) : t + 1;
        const c = I ? I.getX(t + 2) : t + 2;
        index[io++] = vo + a;
        index[io++] = vo + (flip ? c : b);
        index[io++] = vo + (flip ? b : c);
      }
      vo += P.count;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    const mesh = new THREE.Mesh(g, this.material);
    mesh.castShadow = this.cast;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }
}

function instanceMatrix(inst, target) {
  const s = inst.s;
  if (Array.isArray(s)) _s.set(s[0], s[1], s[2]);
  else _s.set(s, s, s);
  _q.setFromAxisAngle(UP, inst.r || 0);
  _p.set(inst.p[0], inst.p[1], inst.p[2]);
  return target.compose(_p, _q, _s);
}

// --------------------------------------------------------------------------------------------
// Chão: grama com relevo fora da muralha + calçamento molhado (grade única, sem sobreposição)
// --------------------------------------------------------------------------------------------
function wave(x, z) {
  return Math.sin(0.53 * x + 0.3) * Math.cos(0.47 * z - 0.8) * 0.6 + Math.sin(0.21 * x + 0.19 * z + 2.0) * 0.4;
}

function buildGroundGridGeometry(rects, bounds, cell, yBase, yAmp, withWetness) {
  const x0 = Math.floor((bounds.minX - 4) / cell) * cell;
  const z0 = Math.floor((bounds.minZ - 4) / cell) * cell;
  const nx = Math.ceil((bounds.maxX + 4 - x0) / cell);
  const nz = Math.ceil((bounds.maxZ + 4 - z0) / cell);
  const covered = new Uint8Array(nx * nz);
  for (const r of rects) {
    const i0 = Math.max(0, Math.floor((r.minX - x0) / cell));
    const i1 = Math.min(nx, Math.ceil((r.maxX - x0) / cell));
    const j0 = Math.max(0, Math.floor((r.minZ - z0) / cell));
    const j1 = Math.min(nz, Math.ceil((r.maxZ - z0) / cell));
    for (let i = i0; i < i1; i++) {
      for (let j = j0; j < j1; j++) covered[i * nz + j] = 1;
    }
  }
  const vid = new Int32Array((nx + 1) * (nz + 1)).fill(-1);
  const pos = [];
  const uvs = [];
  const wet = withWetness ? [] : null;
  const idx = [];
  const vert = (i, j) => {
    const k = i * (nz + 1) + j;
    if (vid[k] >= 0) return vid[k];
    const x = x0 + i * cell;
    const z = z0 + j * cell;
    const w = wave(x, z);
    pos.push(x, yBase + yAmp * w, z);
    uvs.push(x, z);
    if (wet) {
      const low = Math.max(0, Math.min(1, (-w - 0.12) / 0.55));
      wet.push(low * low * (3 - 2 * low));
    }
    vid[k] = pos.length / 3 - 1;
    return vid[k];
  };
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      if (!covered[i * nz + j]) continue;
      const a = vert(i, j);
      const bb = vert(i + 1, j);
      const c = vert(i + 1, j + 1);
      const d = vert(i, j + 1);
      idx.push(a, d, c, a, c, bb);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  if (wet) geo.setAttribute("_wetness", new THREE.Float32BufferAttribute(wet, 1));
  geo.setIndex(new THREE.Uint32BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  return geo;
}

function buildGround(city, materials) {
  const group = new THREE.Group();
  group.name = "Ground";
  // Terreno: plano centrado no mapa (city.terrain) com colinas a partir do retângulo da muralha externa
  const t = city.terrain || { minX: -69, maxX: 69, minZ: -69, maxZ: 69, cx: 0, cz: 0, size: 240 };
  // Parâmetros do relevo: fonte única em tools/build_city.py (TERRAIN_HILL) -> city.json terrain.hill. O teste
  // (test_city.py, terrain_mesh_height) reproduz esta mesma malha para provar que nada andável fica dentro do morro.
  const hill = t.hill;
  if (!hill) throw new Error("city.json sem terrain.hill: rode python tools/build_city.py");
  const size = t.size;
  const seg = Math.round(size / hill.cell);
  const terrain = new THREE.PlaneGeometry(size, size, seg, seg);
  terrain.rotateX(-Math.PI / 2);
  terrain.translate(t.cx, 0, t.cz);
  const tp = terrain.attributes.position;
  const tuv = terrain.attributes.uv;
  const flatZones = city.flatZones || [];
  for (let i = 0; i < tp.count; i++) {
    const x = tp.getX(i);
    const z = tp.getZ(i);
    const dWall = Math.max(t.minX - x, x - t.maxX, t.minZ - z, z - t.maxZ);
    let hillFactor = dWall > 0 ? Math.min(1, dWall / hill.ramp) ** hill.power : 0;
    for (let k = 0; k < flatZones.length && hillFactor > 0; k++) {
      const fz = flatZones[k];
      const dFz = Math.max(fz.minX - x, x - fz.maxX, fz.minZ - z, z - fz.maxZ);
      hillFactor *= Math.max(0, Math.min(1, dFz / (fz.blend || hill.blend)));
    }
    const rise = hillFactor * (hill.rise + Math.sin(x * hill.freqX) * Math.cos(z * hill.freqZ) * hill.amp);
    tp.setY(i, hill.base + rise);
    tuv.setXY(i, x, z);
  }
  terrain.computeVertexNormals();
  // Preset alta: grama PBR completa; desempenho: só a textura de cor (normal/roughness ~0,4 ms numa iGPU)
  const grassSet = materials.textureSet("ground");
  const grassMat = new THREE.MeshStandardMaterial({ color: 0x8fae78, roughness: 0.95 });
  if (QUALITY.groundDetail) {
    grassMat.userData = { pbr_set: "ground", normal_scale: 0.8 };
    materials.prepare(grassMat, terrain);
  } else {
    grassMat.map = grassSet ? grassSet.map : null;
  }
  const tMesh = new THREE.Mesh(terrain, grassMat);
  tMesh.receiveShadow = true;
  tMesh.matrixAutoUpdate = false;
  group.add(tMesh);

  // Calçamento: rasteriza os retângulos numa grade de 0,5 m e emite cada célula uma vez
  const cobbleRects = (city.ground && city.ground.cobble) || [];
  if (cobbleRects.length) {
    const cobble = buildGroundGridGeometry(cobbleRects, city.walk, 0.5, 0.012, 0.025, true);
    const cobbleMat = new THREE.MeshStandardMaterial({ color: 0xc6c8d0, roughness: 0.6 });
    cobbleMat.userData = { pbr_set: "cobble_wet", normal_scale: 0.9, wet_puddles: 1 };
    materials.prepare(cobbleMat, cobble);
    if (!QUALITY.groundDetail) {
      // Preset desempenho: as poças já sobrescrevem a rugosidade; o mapa custava ~0,5 ms numa iGPU
      cobbleMat.roughnessMap = null;
      cobbleMat.roughness = 0.62;
    }
    const cMesh = new THREE.Mesh(cobble, cobbleMat);
    cMesh.receiveShadow = true;
    cMesh.matrixAutoUpdate = false;
    group.add(cMesh);
  }

  // Trilhas e acampamentos de terra batida (grade de 0,75 m sobre a união dos retângulos)
  const dirtRects = city.ground && city.ground.dirt;
  if (dirtRects && dirtRects.length) {
    let dMinX = Infinity;
    let dMaxX = -Infinity;
    let dMinZ = Infinity;
    let dMaxZ = -Infinity;
    for (const r of dirtRects) {
      if (r.minX < dMinX) dMinX = r.minX;
      if (r.maxX > dMaxX) dMaxX = r.maxX;
      if (r.minZ < dMinZ) dMinZ = r.minZ;
      if (r.maxZ > dMaxZ) dMaxZ = r.maxZ;
    }
    const dirtBounds = Number.isFinite(dMinX) ? { minX: dMinX, maxX: dMaxX, minZ: dMinZ, maxZ: dMaxZ } : city.walk;
    const dirtGeo = buildGroundGridGeometry(dirtRects, dirtBounds, 0.75, 0.008, 0.015, false);
    if (dirtGeo.getIndex().count > 0) {
      const dirtMat = new THREE.MeshStandardMaterial({ color: 0x8b6f4e, roughness: 0.94, map: grassSet ? grassSet.map : null });
      const dMesh = new THREE.Mesh(dirtGeo, dirtMat);
      dMesh.receiveShadow = true;
      dMesh.matrixAutoUpdate = false;
      group.add(dMesh);
    }
  }

  // Lagos e riachos com shader animado de água
  const waterRects = city.ground && city.ground.water;
  if (waterRects && waterRects.length) {
    const waterMat = new THREE.MeshStandardMaterial({
      color: 0x2d6e96,
      roughness: 0.08,
      metalness: 0.1,
      transparent: true,
      opacity: 0.86,
      envMapIntensity: 1.4,
    });
    materials.enableWater(waterMat);
    for (const r of waterRects) {
      const w = r.maxX - r.minX;
      const d = r.maxZ - r.minZ;
      if (w <= 0 || d <= 0) continue;
      const wg = new THREE.PlaneGeometry(w, d, Math.max(4, Math.ceil(w / 2)), Math.max(4, Math.ceil(d / 2)));
      wg.rotateX(-Math.PI / 2);
      const wMesh = new THREE.Mesh(wg, waterMat);
      wMesh.position.set((r.minX + r.maxX) * 0.5, 0.02, (r.minZ + r.maxZ) * 0.5);
      wMesh.receiveShadow = true;
      wMesh.matrixAutoUpdate = false;
      wMesh.updateMatrix();
      group.add(wMesh);
    }
  }
  return group;
}

// --------------------------------------------------------------------------------------------
// Efeitos de luz baratos: poças de luz no chão, halos, cristal e fogo (janelas: interiors.js)
// --------------------------------------------------------------------------------------------
function buildLightPools(lights, nightUniform) {
  const pools = lights.filter((l) => l.pool > 0);
  if (!pools.length) return null;
  const pos = new Float32Array(pools.length * 12);
  const col = new Float32Array(pools.length * 12);
  const uv = new Float32Array(pools.length * 8);
  const index = [];
  pools.forEach((l, k) => {
    const r = l.pool;
    [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([u, v], i) => {
      pos.set([l.position.x + u * r, 0.06, l.position.z + v * r], k * 12 + i * 3);
      col.set([l.color.r, l.color.g, l.color.b], k * 12 + i * 3);
      uv.set([u, v], k * 8 + i * 2);
    });
    const o = k * 4;
    index.push(o, o + 2, o + 1, o, o + 3, o + 2);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setIndex(index);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    uniforms: { uNight: nightUniform },
    vertexShader: /* glsl */ `
      varying vec2 vUv; varying vec3 vColor;
      void main() { vUv = uv; vColor = color; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uNight; varying vec2 vUv; varying vec3 vColor;
      void main() {
        float d = length(vUv);
        float a = pow(max(0.0, 1.0 - d), 2.2) * 0.32 * uNight;
        gl_FragColor = vec4(vColor * a, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = "LightPools";
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  return mesh;
}

function buildGlows(world, nightUniform) {
  const sources = [];
  for (const l of world.lights) if (l.glow > 0) sources.push({ p: l.position, c: l.color, size: l.glow, night: l.key.startsWith("Lamp") || l.key.startsWith("Guilda") || l.key.startsWith("Portao") ? 1 : 0, collect: "" });
  for (const g of world.glows) sources.push({ p: new THREE.Vector3(...g.p), c: new THREE.Color(g.color), size: g.size, night: 0, collect: g.collect || "" });
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(sources.length * 3);
  const col = new Float32Array(sources.length * 3);
  const size = new Float32Array(sources.length);
  const night = new Float32Array(sources.length);
  sources.forEach((s, i) => {
    pos.set([s.p.x, s.p.y, s.p.z], i * 3);
    col.set([s.c.r, s.c.g, s.c.b], i * 3);
    size[i] = s.size;
    night[i] = s.night;
  });
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
  geo.setAttribute("aNight", new THREE.BufferAttribute(night, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
    uniforms: { uScale: { value: 1 }, uTime: { value: 0 }, uNight: nightUniform },
    vertexShader: /* glsl */ `
      attribute float aSize, aNight;
      uniform float uScale, uTime, uNight;
      varying vec3 vColor;
      void main() {
        vColor = color * mix(1.0, uNight, aNight);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float pulse = 1.0 + sin(uTime * 3.1 + position.x * 1.7) * 0.05;
        gl_PointSize = aSize * pulse * uScale / -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = pow(max(0.0, 1.0 - d), 2.4) * 0.55;
        gl_FragColor = vec4(vColor * a, a);
      }`,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.name = "Glows";
  points.userData.sources = sources;
  return points;
}

function buildCrystal(anchor) {
  const geo = new THREE.OctahedronGeometry(0.42, 0);
  geo.scale(1, 1.8, 1);
  const mat = new THREE.MeshStandardMaterial({ color: 0x7fe3ff, emissive: 0x2fb8ff, emissiveIntensity: 2.2, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.92 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(anchor.position);
  mesh.name = "ManaCrystal";
  return mesh;
}

// Chamas em Points animados só no shader (uma chamada para todas as fogueiras)
function buildFires(world) {
  const fires = Object.values(world.anchors).filter((a) => a.fire);
  if (!fires.length) return null;
  const per = 14;
  const pos = new Float32Array(fires.length * per * 3);
  const seed = new Float32Array(fires.length * per);
  const scale = new Float32Array(fires.length * per);
  fires.forEach((f, k) => {
    for (let i = 0; i < per; i++) {
      const j = k * per + i;
      pos.set([f.position.x + (Math.random() - 0.5) * 0.35 * f.size, f.position.y, f.position.z + (Math.random() - 0.5) * 0.35 * f.size], j * 3);
      seed[j] = Math.random();
      scale[j] = f.size;
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
  geo.setAttribute("aScale", new THREE.BufferAttribute(scale, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uScale: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute float aSeed, aScale;
      uniform float uTime, uScale;
      varying float vLife;
      void main() {
        float life = fract(uTime * (0.9 + aSeed * 0.8) + aSeed * 13.0);
        vLife = life;
        vec3 p = position;
        p.y += life * 0.75 * aScale;
        p.x += sin(uTime * 6.0 + aSeed * 40.0) * 0.06 * life;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = (0.55 - life * 0.35) * aScale * uScale / -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vLife;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = pow(max(0.0, 1.0 - d), 1.6) * (1.0 - vLife);
        vec3 col = mix(vec3(1.0, 0.85, 0.4), vec3(1.0, 0.25, 0.05), vLife);
        gl_FragColor = vec4(col * a, a);
      }`,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.name = "Fires";
  world.fires = fires;
  return points;
}

// Partículas ambientais (city.json -> particles): esporos e vagalumes na Mata, poeira dourada nas Ruínas.
// Um único Points com pool fixo; o movimento inteiro é do shader (o frame só troca uTime/uScale).
const PARTICLE_KIND = Object.freeze({ spores: 0, fireflies: 1, dust: 2 });

/**
 * @param {{particles?: Array<{kind: string, minX: number, maxX: number, minZ: number, maxZ: number, y0: number, y1: number, count: number, color: string, size: number, night: number, speed: number}>}} city
 * @param {{value: number}} nightUniform
 * @returns {THREE.Points | null}
 */
function buildAmbientParticles(city, nightUniform) {
  const fields = city.particles || [];
  let total = 0;
  for (const f of fields) total += f.count;
  if (!total) return null;
  const pos = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  const params = new Float32Array(total * 4);
  const look = new Float32Array(total * 2);
  const c = new THREE.Color();
  let j = 0;
  for (const f of fields) {
    c.set(f.color);
    const kind = PARTICLE_KIND[f.kind] ?? 0;
    for (let i = 0; i < f.count; i++, j++) {
      pos[j * 3] = f.minX + Math.random() * (f.maxX - f.minX);
      pos[j * 3 + 1] = f.y0;
      pos[j * 3 + 2] = f.minZ + Math.random() * (f.maxZ - f.minZ);
      col[j * 3] = c.r;
      col[j * 3 + 1] = c.g;
      col[j * 3 + 2] = c.b;
      params[j * 4] = Math.random();
      params[j * 4 + 1] = kind;
      params[j * 4 + 2] = Math.max(0.1, f.y1 - f.y0);
      params[j * 4 + 3] = f.speed * (0.7 + Math.random() * 0.6);
      look[j * 2] = f.size * (0.7 + Math.random() * 0.6);
      look[j * 2 + 1] = f.night;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setAttribute("aParams", new THREE.BufferAttribute(params, 4));
  geo.setAttribute("aLook", new THREE.BufferAttribute(look, 2));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
    uniforms: { uTime: { value: 0 }, uScale: { value: 1 }, uNight: nightUniform },
    vertexShader: /* glsl */ `
      attribute vec4 aParams;   // semente, tipo (0 esporo, 1 vagalume, 2 poeira), faixa de altura, velocidade
      attribute vec2 aLook;     // tamanho (m), quanto some de dia
      uniform float uTime, uScale, uNight;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        float seed = aParams.x;
        float kind = aParams.y;
        float span = aParams.z;
        float spd = aParams.w;
        vec3 p = position;
        float t = uTime * spd + seed * 37.0;
        float alpha;
        if (kind < 0.5) {
          // esporo: sobe devagar em espiral e reaparece embaixo
          float life = fract(seed * 7.13 + uTime * spd / span);
          p.y += life * span;
          p.x += sin(t * 1.3) * 0.9;
          p.z += cos(t * 1.1) * 0.9;
          alpha = smoothstep(0.0, 0.15, life) * (1.0 - smoothstep(0.8, 1.0, life)) * 0.75;
        } else if (kind < 1.5) {
          // vagalume: vaga em laço e pisca
          p.y += (0.5 + 0.5 * sin(t * 0.7)) * span;
          p.x += sin(t * 0.9) * 2.2 + sin(t * 2.3) * 0.3;
          p.z += cos(t * 0.8) * 2.2;
          alpha = pow(max(0.0, sin(uTime * (1.2 + seed * 1.6) + seed * 40.0)), 3.0);
        } else {
          // poeira: flutua quase parada e cintila à luz
          p.y += fract(seed * 3.7 + uTime * spd / span * 0.35) * span;
          p.x += sin(t * 0.5) * 0.6;
          p.z += sin(t * 0.4 + 1.7) * 0.6;
          alpha = 0.35 + 0.35 * sin(uTime * 2.0 + seed * 60.0);
        }
        vAlpha = alpha * mix(1.0, uNight, aLook.y);
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = min(28.0, aLook.x * uScale / max(0.5, -mv.z));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = pow(max(0.0, 1.0 - d), 2.0) * vAlpha;
        if (a < 0.003) discard;
        gl_FragColor = vec4(vColor * a, a);
      }`,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.name = "AmbientParticles";
  return points;
}

// --------------------------------------------------------------------------------------------
// Peças articuladas (contrato 'hinge' do city.json): folhas de porta, portão do castelo, tampa de
// baú. O nó nomeado do GLB já tem o pivô na dobradiça; ele sai da fusão estática e vira uma
// instância de InstancedMesh (uma por geometria/material) cuja matriz é base × giro × local.
// Portas Kenney antigas (só 'door', sem 'hinge') ganham um hinge sintetizado com os padrões do CONFIG.
// --------------------------------------------------------------------------------------------
const _hm = new THREE.Matrix4();
const _hr = new THREE.Matrix4();
const _hq = new THREE.Quaternion();
const AXIS_X = new THREE.Vector3(1, 0, 0);

// Nomes e matrizes (no espaço do GLB) do nó e de todos os ancestrais: o loader acha o nó da dobradiça
function nodeChain(o) {
  const chain = [];
  for (let n = o; n; n = n.parent) chain.push({ name: n.name, matrix: n.matrixWorld.clone() });
  return chain;
}

function hingeSpecOf(it, doorById) {
  const d = CONFIG.props.hinge;
  if (it.hinge) {
    const h = it.hinge;
    return { key: h.key, node: h.node, axis: h.axis === "x" ? "x" : "y", angle: Number(h.angle ?? d.angle), dur: Number(h.dur ?? d.dur), open: Boolean(h.open) };
  }
  if (it.door) {
    const door = doorById.get(it.door);
    return { key: it.door, node: d.doorNode, axis: "y", angle: d.angle, dur: d.dur, open: Boolean(door && door.open) };
  }
  return null;
}

function hingeRecord(hingeParts, hinge) {
  let h = hingeParts.get(hinge.key);
  if (!h) {
    h = { ...hinge, parts: [], nodes: [] };
    hingeParts.set(hinge.key, h);
  }
  return h;
}

// Parte de uma instância estática: true se pertence ao nó articulado (e foi separada)
function collectHingePart(hingeParts, hinge, part, inst, matKey, material, cast) {
  let node = null;
  for (const c of part.chain) {
    if (c.name === hinge.node) {
      node = c;
      break;
    }
  }
  if (!node) return false;
  const base = new THREE.Matrix4().multiplyMatrices(inst, node.matrix);
  const local = new THREE.Matrix4().copy(node.matrix).invert().multiply(part.matrix);
  hingeRecord(hingeParts, hinge).parts.push({ geometry: part.geometry, material, matKey, cast, base, local });
  return true;
}

// Instância 'dyn' (objeto solto): gira o próprio nó clonado
function collectHingeNode(hingeParts, hinge, obj) {
  const node = obj.getObjectByName(hinge.node);
  if (!node) return;
  hingeRecord(hingeParts, hinge).nodes.push({ node, q0: node.quaternion.clone() });
}

function buildHinges(scene, hingeParts) {
  const groups = new Map();
  for (const h of hingeParts.values()) {
    for (const p of h.parts) {
      const gkey = `${p.geometry.uuid}|${p.matKey}|${p.cast ? 1 : 0}`;
      if (!groups.has(gkey)) groups.set(gkey, { geometry: p.geometry, material: p.material, cast: p.cast, items: [] });
      groups.get(gkey).items.push({ h, p });
    }
  }
  const hinges = new Map();
  for (const h of hingeParts.values()) {
    const center = new THREE.Vector3();
    let n = 0;
    for (const p of h.parts) {
      center.add(_p.setFromMatrixPosition(p.base));
      n++;
    }
    for (const nd of h.nodes) {
      nd.node.updateWorldMatrix(true, false);
      center.add(_p.setFromMatrixPosition(nd.node.matrixWorld));
      n++;
    }
    if (n) center.multiplyScalar(1 / n);
    hinges.set(h.key, { key: h.key, axis: h.axis, angle: h.angle, dur: h.dur, open: h.open, center, entries: [], nodes: h.nodes, current: NaN });
  }
  for (const g of groups.values()) {
    const mesh = new THREE.InstancedMesh(g.geometry, g.material, g.items.length);
    mesh.name = "HingedParts";
    mesh.castShadow = g.cast;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    g.items.forEach(({ h, p }, i) => {
      _hm.multiplyMatrices(p.base, p.local);
      mesh.setMatrixAt(i, _hm);
      hinges.get(h.key).entries.push({ mesh, index: i, base: p.base, local: p.local });
    });
    scene.add(mesh);
  }
  for (const h of hinges.values()) setHingeAngle(h, h.open ? h.angle : 0);
  return hinges;
}

// Giro absoluto (radianos) em torno do eixo local do nó; sem alocação (chamado durante animações)
export function setHingeAngle(h, angle) {
  if (h.current === angle) return;
  h.current = angle;
  if (h.axis === "x") _hr.makeRotationX(angle);
  else _hr.makeRotationY(angle);
  for (let i = 0; i < h.entries.length; i++) {
    const e = h.entries[i];
    _hm.multiplyMatrices(e.base, _hr).multiply(e.local);
    e.mesh.setMatrixAt(e.index, _hm);
    e.mesh.instanceMatrix.needsUpdate = true;
  }
  for (let i = 0; i < h.nodes.length; i++) {
    const nd = h.nodes[i];
    _hq.setFromAxisAngle(h.axis === "x" ? AXIS_X : UP, angle);
    nd.node.quaternion.copy(nd.q0).multiply(_hq);
  }
}

// --------------------------------------------------------------------------------------------
// Estruturas procedurais (monólito, santuários, tendas de acampamento)
// --------------------------------------------------------------------------------------------
const _customTexCache = new Map();
const _customTexLoader = new THREE.TextureLoader();

function createRuneFallbackCanvas() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  const cx = 128;
  const grad = g.createRadialGradient(cx, cx, 12, cx, cx, 124);
  grad.addColorStop(0, "rgba(120, 240, 255, 0.55)");
  grad.addColorStop(0.55, "rgba(70, 210, 255, 0.25)");
  grad.addColorStop(1, "rgba(40, 160, 255, 0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = "rgba(170, 250, 255, 0.92)";
  g.lineWidth = 4;
  g.beginPath();
  g.arc(cx, cx, 108, 0, Math.PI * 2);
  g.stroke();
  g.lineWidth = 2.5;
  g.beginPath();
  g.arc(cx, cx, 84, 0, Math.PI * 2);
  g.stroke();
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * 84, cx + Math.sin(a) * 84);
    g.lineTo(cx + Math.cos(a) * 108, cx + Math.sin(a) * 108);
    g.stroke();
    const b = a + Math.PI / 4;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * 62, cx + Math.sin(a) * 62);
    g.lineTo(cx + Math.cos(b) * 62, cx + Math.sin(b) * 62);
    g.stroke();
  }
  return c;
}

function createCrestFallbackCanvas() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  g.beginPath();
  g.moveTo(36, 24);
  g.lineTo(220, 24);
  g.lineTo(220, 146);
  g.quadraticCurveTo(220, 212, 128, 238);
  g.quadraticCurveTo(36, 212, 36, 146);
  g.closePath();
  g.fillStyle = "#1c2d4a";
  g.fill();
  g.save();
  g.clip();
  g.fillStyle = "#7a2626";
  g.fillRect(128, 24, 92, 214);
  g.restore();
  g.lineWidth = 10;
  g.strokeStyle = "#d9ad5b";
  g.stroke();
  g.fillStyle = "#78e4ff";
  g.beginPath();
  g.moveTo(128, 56);
  g.lineTo(148, 114);
  g.lineTo(192, 122);
  g.lineTo(150, 142);
  g.lineTo(128, 200);
  g.lineTo(106, 142);
  g.lineTo(64, 122);
  g.lineTo(108, 114);
  g.closePath();
  g.fill();
  return c;
}

function loadCustomTexture(url, fallbackBuilder) {
  if (_customTexCache.has(url)) return _customTexCache.get(url);
  let tex;
  if (typeof document !== "undefined") {
    tex = new THREE.Texture(fallbackBuilder());
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
  } else {
    tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    tex.needsUpdate = true;
  }
  try {
    _customTexLoader.load(
      url,
      (loaded) => {
        if (loaded && loaded.image) {
          tex.image = loaded.image;
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.needsUpdate = true;
        }
      },
      undefined,
      () => {
        /* textura opcional ausente: mantém fallback procedural */
      }
    );
  } catch (_) {
    /* ambiente sem carregador DOM: mantém fallback */
  }
  _customTexCache.set(url, tex);
  return tex;
}

function buildAncientMonolith(world) {
  const anchors = Object.values(world.anchors).filter((a) => a.monolith);
  if (!anchors.length) return null;
  const stoneMat = new THREE.MeshStandardMaterial({ color: 0x545d66, roughness: 0.9, metalness: 0.06, flatShading: true });
  const shardMat = new THREE.MeshStandardMaterial({ color: 0x434d58, emissive: 0x165578, emissiveIntensity: 0.45, roughness: 0.78, metalness: 0.12, flatShading: true });
  const ringMat = new THREE.MeshStandardMaterial({ color: 0x3b4d5e, emissive: 0x2496cc, emissiveIntensity: 0.95, roughness: 0.35, metalness: 0.55, flatShading: true });
  const crystalMat = new THREE.MeshStandardMaterial({ color: 0x7ef2ff, emissive: 0x26b8ff, emissiveIntensity: 2.0, roughness: 0.15, metalness: 0.15, transparent: true, opacity: 0.92, flatShading: true });
  const runeTex = loadCustomTexture("./textures/custom/runic_circle.png", createRuneFallbackCanvas);
  const runeMat = new THREE.MeshBasicMaterial({
    map: runeTex,
    color: 0x5be4ff,
    transparent: true,
    opacity: 0.72,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });

  const tier1Geo = new THREE.CylinderGeometry(2.2, 2.5, 0.36, 8);
  const tier2Geo = new THREE.CylinderGeometry(1.55, 1.8, 0.34, 8);
  const tier3Geo = new THREE.CylinderGeometry(1.05, 1.25, 0.28, 8);
  const shardShaftGeo = new THREE.CylinderGeometry(0.14, 0.32, 1.45, 4);
  const shardTipGeo = new THREE.ConeGeometry(0.14, 0.36, 4);
  const ring1Geo = new THREE.TorusGeometry(1.18, 0.045, 6, 24);
  const ring2Geo = new THREE.TorusGeometry(0.92, 0.038, 6, 20);
  const crystalGeo = new THREE.OctahedronGeometry(0.55, 0);
  crystalGeo.scale(0.85, 1.75, 0.85);
  const runeGeo = new THREE.PlaneGeometry(6.2, 6.2);
  runeGeo.rotateX(-Math.PI / 2);

  const entries = [];
  for (const a of anchors) {
    const group = new THREE.Group();
    group.name = "AncientMonolith";
    group.position.copy(a.position);
    if (a.rot) group.rotation.y = a.rot;
    if (a.scale) group.scale.setScalar(a.scale);

    const t1 = new THREE.Mesh(tier1Geo, stoneMat);
    t1.position.y = 0.18;
    const t2 = new THREE.Mesh(tier2Geo, stoneMat);
    t2.position.y = 0.53;
    const t3 = new THREE.Mesh(tier3Geo, stoneMat);
    t3.position.y = 0.84;
    for (const t of [t1, t2, t3]) {
      t.castShadow = true;
      t.receiveShadow = true;
      group.add(t);
    }

    const shards = [];
    for (let i = 0; i < 3; i++) {
      const ang = (i * Math.PI * 2) / 3;
      const shard = new THREE.Group();
      const shaft = new THREE.Mesh(shardShaftGeo, shardMat);
      shaft.castShadow = true;
      shaft.receiveShadow = true;
      const tip = new THREE.Mesh(shardTipGeo, shardMat);
      tip.position.y = 0.905;
      tip.castShadow = true;
      shard.add(shaft, tip);
      shard.position.set(Math.cos(ang) * 1.55, 1.95, Math.sin(ang) * 1.55);
      shard.rotation.y = -ang;
      shard.rotation.z = 0.14;
      group.add(shard);
      shards.push({ mesh: shard, baseY: 1.95, baseRot: -ang, phase: i * 2.1 });
    }

    const pivot1 = new THREE.Group();
    pivot1.position.y = 2.35;
    pivot1.rotation.set(0.45, 0.2, 0.3);
    const ring1 = new THREE.Mesh(ring1Geo, ringMat);
    pivot1.add(ring1);

    const pivot2 = new THREE.Group();
    pivot2.position.y = 2.35;
    pivot2.rotation.set(-0.55, 0.4, -0.35);
    const ring2 = new THREE.Mesh(ring2Geo, ringMat);
    pivot2.add(ring2);
    group.add(pivot1, pivot2);

    const crystal = new THREE.Mesh(crystalGeo, crystalMat);
    crystal.position.y = 2.35;
    group.add(crystal);

    const runeDisc = new THREE.Mesh(runeGeo, runeMat);
    runeDisc.position.y = 0.04;
    runeDisc.renderOrder = 1;
    group.add(runeDisc);

    entries.push({ group, crystal, crystalBaseY: 2.35, ring1, ring2, shards, runeDisc });
  }
  return {
    entries,
    group: entries[0].group,
    crystal: entries[0].crystal,
    rings: [entries[0].ring1, entries[0].ring2],
    shards: entries[0].shards,
    runeDisc: entries[0].runeDisc,
  };
}

function buildShrines(world) {
  const anchors = Object.values(world.anchors).filter((a) => a.shrine);
  if (!anchors.length) return [];
  const stoneMat = new THREE.MeshStandardMaterial({ color: 0x676f78, roughness: 0.88, metalness: 0.06, flatShading: true });
  const crystalMat = new THREE.MeshStandardMaterial({ color: 0x7ef2ff, emissive: 0x26b8ff, emissiveIntensity: 1.8, roughness: 0.2, transparent: true, opacity: 0.9, flatShading: true });
  const runeTex = loadCustomTexture("./textures/custom/runic_circle.png", createRuneFallbackCanvas);
  const runeMat = new THREE.MeshBasicMaterial({
    map: runeTex,
    color: 0x5be4ff,
    transparent: true,
    opacity: 0.58,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });

  const plinthGeo = new THREE.CylinderGeometry(0.95, 1.15, 0.26, 8);
  const shaftGeo = new THREE.CylinderGeometry(0.62, 0.76, 0.72, 8);
  const capGeo = new THREE.CylinderGeometry(0.74, 0.58, 0.18, 8);
  const crystalGeo = new THREE.OctahedronGeometry(0.16, 0);
  crystalGeo.scale(0.8, 1.5, 0.8);
  const runeGeo = new THREE.PlaneGeometry(3.2, 3.2);
  runeGeo.rotateX(-Math.PI / 2);

  const shrines = [];
  anchors.forEach((a, idx) => {
    const group = new THREE.Group();
    group.name = "Shrine";
    group.position.copy(a.position);
    if (a.rot) group.rotation.y = a.rot;
    if (a.scale) group.scale.setScalar(a.scale);

    const plinth = new THREE.Mesh(plinthGeo, stoneMat);
    plinth.position.y = 0.13;
    const shaft = new THREE.Mesh(shaftGeo, stoneMat);
    shaft.position.y = 0.62;
    const cap = new THREE.Mesh(capGeo, stoneMat);
    cap.position.y = 1.07;
    for (const part of [plinth, shaft, cap]) {
      part.castShadow = true;
      part.receiveShadow = true;
      group.add(part);
    }

    const crystals = [];
    for (let i = 0; i < 3; i++) {
      const phase = (i * Math.PI * 2) / 3 + idx * 0.9;
      const mesh = new THREE.Mesh(crystalGeo, crystalMat);
      mesh.position.set(Math.cos(phase) * 0.62, 1.52, Math.sin(phase) * 0.62);
      group.add(mesh);
      crystals.push({ mesh, radius: 0.62, baseY: 1.52, phase });
    }

    const runeRing = new THREE.Mesh(runeGeo, runeMat);
    runeRing.position.y = 0.035;
    runeRing.renderOrder = 1;
    group.add(runeRing);

    shrines.push({ group, crystals, runeRing });
  });
  return shrines;
}

function buildCampTents(world) {
  const anchors = Object.values(world.anchors).filter((a) => a.tent);
  if (!anchors.length) return [];
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x5c3e26, roughness: 0.92, flatShading: true });
  const ropeMat = new THREE.MeshStandardMaterial({ color: 0xbda682, roughness: 0.95 });
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x3b3026, roughness: 0.96, side: THREE.DoubleSide });

  const dx = 1.28;
  const eaveY = 0.22;
  const ridgeY = 1.98;
  const dy = ridgeY - eaveY;
  const slopeLen = Math.hypot(dx, dy);
  const tilt = Math.atan2(dy, dx);
  const roofGeo = new THREE.PlaneGeometry(slopeLen + 0.08, 3.15);
  roofGeo.rotateX(-Math.PI / 2);
  const skirtGeo = new THREE.PlaneGeometry(3.15, eaveY + 0.02);
  skirtGeo.rotateY(Math.PI / 2);

  const backShape = new THREE.Shape();
  backShape.moveTo(-dx, 0.02);
  backShape.lineTo(dx, 0.02);
  backShape.lineTo(dx, eaveY);
  backShape.lineTo(0, ridgeY);
  backShape.lineTo(-dx, eaveY);
  backShape.closePath();
  const backGeo = new THREE.ShapeGeometry(backShape);

  const floorGeo = new THREE.PlaneGeometry(2.35, 2.9);
  floorGeo.rotateX(-Math.PI / 2);
  const postGeo = new THREE.CylinderGeometry(0.055, 0.065, 2.05, 6);
  const ridgeGeo = new THREE.CylinderGeometry(0.05, 0.05, 3.35, 6);
  ridgeGeo.rotateX(Math.PI / 2);
  const stakeGeo = new THREE.CylinderGeometry(0.03, 0.02, 0.34, 5);
  const ropeGeo = new THREE.CylinderGeometry(0.012, 0.012, 1, 4);
  const barGeo = new THREE.CylinderGeometry(0.025, 0.025, 0.65, 5);
  barGeo.rotateZ(Math.PI / 2);
  const bannerGeo = new THREE.PlaneGeometry(0.56, 0.72);

  let crestMat = null;
  const tents = [];
  const aVec = new THREE.Vector3();
  const bVec = new THREE.Vector3();
  const dirVec = new THREE.Vector3();

  for (const a of anchors) {
    const spec = typeof a.tent === "object" && a.tent !== null ? a.tent : {};
    const group = new THREE.Group();
    group.name = "CampTent";
    group.position.copy(a.position);
    group.rotation.y = spec.rot || 0;
    group.scale.setScalar(spec.scale || 1);

    const canvasMat = new THREE.MeshStandardMaterial({
      color: spec.color || 0xb88655,
      roughness: 0.9,
      metalness: 0,
      side: THREE.DoubleSide,
      flatShading: true,
    });

    const leftRoof = new THREE.Mesh(roofGeo, canvasMat);
    leftRoof.position.set(-dx * 0.5, eaveY + dy * 0.5, 0);
    leftRoof.rotation.z = tilt;
    const rightRoof = new THREE.Mesh(roofGeo, canvasMat);
    rightRoof.position.set(dx * 0.5, eaveY + dy * 0.5, 0);
    rightRoof.rotation.z = -tilt;
    const leftSkirt = new THREE.Mesh(skirtGeo, canvasMat);
    leftSkirt.position.set(-dx, (eaveY + 0.02) * 0.5, 0);
    const rightSkirt = new THREE.Mesh(skirtGeo, canvasMat);
    rightSkirt.position.set(dx, (eaveY + 0.02) * 0.5, 0);
    const backWall = new THREE.Mesh(backGeo, canvasMat);
    backWall.position.z = -1.55;
    for (const p of [leftRoof, rightRoof, leftSkirt, rightSkirt, backWall]) {
      p.castShadow = true;
      p.receiveShadow = true;
      group.add(p);
    }

    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.position.y = 0.02;
    floor.receiveShadow = true;
    group.add(floor);

    const frontPost = new THREE.Mesh(postGeo, woodMat);
    frontPost.position.set(0, 1.025, 1.55);
    const backPost = new THREE.Mesh(postGeo, woodMat);
    backPost.position.set(0, 1.025, -1.55);
    const ridgePole = new THREE.Mesh(ridgeGeo, woodMat);
    ridgePole.position.set(0, ridgeY, 0);
    for (const p of [frontPost, backPost, ridgePole]) {
      p.castShadow = true;
      p.receiveShadow = true;
      group.add(p);
    }

    // Estacas de canto e cordas esticadas
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const stake = new THREE.Mesh(stakeGeo, woodMat);
        stake.position.set(sx * 1.68, 0.12, sz * 1.42);
        stake.rotation.z = sx * -0.25;
        stake.castShadow = true;
        group.add(stake);

        aVec.set(sx * dx, eaveY + 0.02, sz * 1.42);
        bVec.set(sx * 1.66, 0.22, sz * 1.42);
        dirVec.subVectors(bVec, aVec);
        const len = dirVec.length();
        const rope = new THREE.Mesh(ropeGeo, ropeMat);
        rope.position.copy(aVec).addScaledVector(dirVec, 0.5);
        rope.scale.set(1, len, 1);
        rope.quaternion.setFromUnitVectors(UP, dirVec.normalize());
        group.add(rope);
      }
    }

    if (spec.emblem) {
      if (!crestMat) {
        const crestTex = loadCustomTexture("./textures/custom/guild_crest.png", createCrestFallbackCanvas);
        crestMat = new THREE.MeshStandardMaterial({
          map: crestTex,
          transparent: true,
          alphaTest: 0.1,
          side: THREE.DoubleSide,
          roughness: 0.75,
        });
      }
      const bar = new THREE.Mesh(barGeo, woodMat);
      bar.position.set(0, 1.62, 1.64);
      const banner = new THREE.Mesh(bannerGeo, crestMat);
      banner.position.set(0, 1.24, 1.64);
      banner.castShadow = true;
      group.add(bar, banner);
    }

    tents.push({ group });
  }
  return tents;
}

// --------------------------------------------------------------------------------------------
export async function loadWorld(scene, materials, onProgress) {
  const city = await fetchJson(CONFIG.assets.city);
  const world = new WorldIndex(city);
  const kitMats = new KitMaterials(city, materials);
  const loader = new GLTFLoader();
  const keys = Object.keys(city.models);
  const protos = new Map();
  let done = 0;
  const queue = [...keys];
  const workers = Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const key = queue.shift();
      const gltf = await loader.loadAsync(city.models[key].url);
      const root = gltf.scene;
      root.updateMatrixWorld(true);
      const parts = [];
      root.traverse((o) => {
        if (o.isMesh && !o.isSkinnedMesh) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          parts.push({ geometry: o.geometry, material: mats[0], matrix: o.matrixWorld.clone(), chain: nodeChain(o) });
        }
      });
      protos.set(key, { root, parts, kit: city.models[key].kit });
      done++;
      if (onProgress) onProgress(done / keys.length);
    }
  });
  await Promise.all(workers);

  const chunk = CONFIG.render.chunkSize;
  const buckets = new Map();
  const instBuckets = new Map();
  const interiors = city.zones.filter((z) => z.interiorOf);
  const inst = new THREE.Matrix4();
  const doorById = new Map((city.doors || []).map((d) => [d.id, d]));
  const hingeParts = new Map();
  for (const it of city.instances) {
    const proto = protos.get(it.m);
    instanceMatrix(it, inst);
    // Peça articulada (folha de porta, portão, tampa de baú): o nó nomeado sai da fusão estática
    const hinge = hingeSpecOf(it, doorById);
    if (it.dyn) {
      const obj = proto.root.clone(true);
      obj.matrixAutoUpdate = false;
      obj.matrix.copy(inst);
      obj.traverse((o) => {
        if (o.isMesh) {
          const { material } = kitMats.get(proto.kit, o.material, it.pal);
          o.material = material;
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      scene.add(obj);
      obj.updateMatrixWorld(true);
      if (!world.dyn.has(it.dyn)) world.dyn.set(it.dyn, []);
      world.dyn.get(it.dyn).push(obj);
      if (hinge) collectHingeNode(hingeParts, hinge, obj);
      continue;
    }
    // Dentro de prédios o telhado já barra o sol: móveis de interior não entram no passe de sombra
    const indoor = interiors.some((z) => it.p[0] > z.minX && it.p[0] < z.maxX && it.p[2] > z.minZ && it.p[2] < z.maxZ);
    const cast = !it.noShadow && it.tag !== "forest" && !indoor;
    // Detalhe pequeno (móveis, adereços, arbustos) some de longe; prédios, árvores e muralha ficam
    const detail = DETAIL_KITS.has(proto.kit) || DETAIL_TAGS.has(it.tag) ? 1 : 0;

    if (!hinge && (proto.kit === "forest" || INSTANCED_TAGS.has(it.tag))) {
      const qx = Math.floor(it.p[0] / 72);
      const qz = Math.floor(it.p[2] / 72);
      for (let partIdx = 0; partIdx < proto.parts.length; partIdx++) {
        const part = proto.parts[partIdx];
        const { key, material } = kitMats.get(proto.kit, part.material, it.pal);
        const ikey = `${it.m}#${partIdx}#${key}#${qx},${qz}#${cast ? 1 : 0}#${detail}`;
        let ib = instBuckets.get(ikey);
        if (!ib) {
          ib = { geometry: part.geometry, material, cast, detail, matrices: [] };
          instBuckets.set(ikey, ib);
        }
        ib.matrices.push(new THREE.Matrix4().multiplyMatrices(inst, part.matrix));
      }
      continue;
    }

    const cx = Math.floor(it.p[0] / chunk);
    const cz = Math.floor(it.p[2] / chunk);
    for (const part of proto.parts) {
      const { key, material } = kitMats.get(proto.kit, part.material, it.pal);
      if (hinge && collectHingePart(hingeParts, hinge, part, inst, key, material, cast)) continue;
      const bkey = `${key}#${cx},${cz}#${cast ? 1 : 0}#${detail}`;
      let b = buckets.get(bkey);
      if (!b) {
        b = new Bucket(material, cast);
        b.detail = detail;
        buckets.set(bkey, b);
      }
      _m.multiplyMatrices(inst, part.matrix);
      b.add(part.geometry, _m);
    }
    if (hinge && !hingeParts.has(hinge.key)) console.warn(`[Alvor] hinge '${hinge.key}': nó '${hinge.node}' não existe em ${it.m} (peça fica estática)`);
  }
  const staticGroup = new THREE.Group();
  staticGroup.name = "CityStatic";
  world.detailMeshes = [];
  for (const b of buckets.values()) {
    const mesh = b.build();
    if (b.detail) world.detailMeshes.push(mesh);
    staticGroup.add(mesh);
  }
  for (const ib of instBuckets.values()) {
    const mesh = new THREE.InstancedMesh(ib.geometry, ib.material, ib.matrices.length);
    mesh.name = "InstancedStatic";
    mesh.castShadow = ib.cast;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    if (!ib.geometry.boundingBox) ib.geometry.computeBoundingBox();
    const gBox = ib.geometry.boundingBox;
    const box = new THREE.Box3();
    for (let i = 0; i < ib.matrices.length; i++) {
      const mat = ib.matrices[i];
      mesh.setMatrixAt(i, mat);
      _tmpBox.copy(gBox).applyMatrix4(mat);
      box.union(_tmpBox);
    }
    mesh.instanceMatrix.needsUpdate = true;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    mesh.boundingBox = box;
    mesh.boundingSphere = sphere;
    mesh.userData.worldSphere = sphere;
    if (ib.detail === 1) world.detailMeshes.push(mesh);
    staticGroup.add(mesh);
  }
  staticGroup.matrixAutoUpdate = false;
  scene.add(staticGroup);
  world.hinges = buildHinges(scene, hingeParts);
  scene.add(buildGround(city, materials));

  world.nightUniform = { value: 1 };
  // Janelas e portas trancadas: salas falsas em paralaxe (interior mapping) + brilho das janelas reais
  world.interiors = buildInteriors(city, world, scene);
  world.poolsMesh = buildLightPools(world.lights, world.nightUniform);
  if (world.poolsMesh) scene.add(world.poolsMesh);
  world.glowPoints = buildGlows(world, world.nightUniform);
  scene.add(world.glowPoints);
  if (world.anchors.ManaCrystal) {
    world.crystal = buildCrystal(world.anchors.ManaCrystal);
    scene.add(world.crystal);
  }
  world.firePoints = buildFires(world);
  if (world.firePoints) scene.add(world.firePoints);
  world.ambientPoints = buildAmbientParticles(city, world.nightUniform);
  if (world.ambientPoints) scene.add(world.ambientPoints);

  world.monolith = buildAncientMonolith(world);
  if (world.monolith) {
    for (const m of world.monolith.entries) scene.add(m.group);
  }
  world.shrines = buildShrines(world);
  for (const s of world.shrines) scene.add(s.group);
  world.tents = buildCampTents(world);
  for (const t of world.tents) scene.add(t.group);

  world.stats = { drawBuckets: buckets.size + instBuckets.size, instances: city.instances.length };
  return world;
}

// Distância de desenho dos detalhes, reavaliada 4x por segundo (bounding sphere já em mundo)
let detailTimer = 0;
export function updateDetailCulling(world, camera, dt) {
  detailTimer += dt;
  if (detailTimer < 0.25) return;
  detailTimer = 0;
  const max2 = QUALITY.detailDistance ** 2;
  const p = camera.position;
  for (const m of world.detailMeshes) {
    const bs = m.userData.worldSphere || m.geometry.boundingSphere;
    if (!bs) continue;
    const c = bs.center;
    const r = bs.radius;
    const d = Math.max(0, Math.hypot(c.x - p.x, c.z - p.z) - r);
    m.visible = d * d < max2;
  }
}

// Atualização por frame dos efeitos do mundo (só uniforms; sem alocação)
export function updateWorldFx(world, elapsed, pixelScale) {
  if (world.interiors) world.interiors.update(elapsed - world.interiors.elapsed, elapsed);
  if (world.glowPoints) {
    world.glowPoints.material.uniforms.uTime.value = elapsed;
    world.glowPoints.material.uniforms.uScale.value = pixelScale;
  }
  if (world.firePoints) {
    world.firePoints.material.uniforms.uTime.value = elapsed;
    world.firePoints.material.uniforms.uScale.value = pixelScale;
  }
  if (world.ambientPoints) {
    world.ambientPoints.material.uniforms.uTime.value = elapsed;
    world.ambientPoints.material.uniforms.uScale.value = pixelScale;
  }
  if (world.crystal) {
    world.crystal.rotation.y = elapsed * 0.6;
    world.crystal.position.y = world.anchors.ManaCrystal.position.y + Math.sin(elapsed * 1.4) * 0.12;
  }
  if (world.monolith) {
    const entries = world.monolith.entries;
    for (let i = 0; i < entries.length; i++) {
      const m = entries[i];
      m.crystal.rotation.y = elapsed * 0.75;
      m.crystal.position.y = m.crystalBaseY + Math.sin(elapsed * 1.5) * 0.14;
      m.ring1.rotation.z = elapsed * 0.65;
      m.ring2.rotation.z = -elapsed * 0.48;
      for (let j = 0; j < m.shards.length; j++) {
        const s = m.shards[j];
        s.mesh.position.y = s.baseY + Math.sin(elapsed * 1.3 + s.phase) * 0.12;
        s.mesh.rotation.y = s.baseRot + Math.sin(elapsed * 0.5 + s.phase) * 0.08;
      }
      m.runeDisc.rotation.y = elapsed * 0.22;
    }
  }
  if (world.shrines && world.shrines.length) {
    for (let i = 0; i < world.shrines.length; i++) {
      const s = world.shrines[i];
      for (let j = 0; j < s.crystals.length; j++) {
        const c = s.crystals[j];
        const ang = elapsed * 1.15 + c.phase;
        c.mesh.position.set(
          Math.cos(ang) * c.radius,
          c.baseY + Math.sin(elapsed * 2.0 + c.phase) * 0.07,
          Math.sin(ang) * c.radius
        );
        c.mesh.rotation.y = elapsed * 1.4 + c.phase;
      }
      s.runeRing.rotation.y = -elapsed * 0.35;
    }
  }
  updateSpinners(world, elapsed);
}

// Peças que giram sem parar (pás do moinho: dyn "spin:<chave>"). A matriz da instância é a base e a
// rotação em X local entra por cima; tudo pré-alocado na primeira chamada.
const SPIN_SPEED = 0.55;
const _spin = new THREE.Matrix4();
function updateSpinners(world, elapsed) {
  if (!world.spinners) {
    world.spinners = [];
    for (const [key, objs] of world.dyn) {
      if (!key.startsWith("spin:")) continue;
      for (const o of objs) world.spinners.push({ obj: o, base: o.matrix.clone() });
    }
  }
  const sp = world.spinners;
  for (let i = 0; i < sp.length; i++) {
    _spin.makeRotationX(elapsed * SPIN_SPEED + i);
    sp[i].obj.matrix.multiplyMatrices(sp[i].base, _spin);
    sp[i].obj.matrixWorldNeedsUpdate = true;
  }
}

// Esconde halos de coletáveis já recolhidos (atributo de tamanho zerado)
export function setCollectGlow(world, key, visible) {
  const pts = world.glowPoints;
  if (!pts) return;
  const sizes = pts.geometry.attributes.aSize;
  pts.userData.sources.forEach((s, i) => {
    if (s.collect === key) sizes.setX(i, visible ? s.size : 0);
  });
  sizes.needsUpdate = true;
}
