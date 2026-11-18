import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { CONFIG } from "./config.js";

// Personagens KayKit (5 corpos, mesmo esqueleto, 76 animações). Cada NPC é um clone com:
//  - textura recolorida por célula do atlas (8 x 4 células de 128 x 256 px), preservando o degradê;
//  - peças/acessórios ocultos por nome;
//  - partes com skinning fundidas numa só malha (1 draw call por personagem em vez de 6+).

const ATLAS_COLS = 8;
const ATLAS_ROWS = 4;

// Encaixes de mão do esqueleto KayKit (nomes no GLB: "handslot.r" / "handslot.l"; o GLTFLoader do three
// remove o ponto ao sanitizar, então em runtime o nó se chama "handslotr"/"handslotl"). Pose relativa ao
// osso copiada das armas que o próprio rig traz (1H_Sword do Knight / Knife do Rogue: giro de 180° em Y na
// mão direita, identidade na esquerda, ~3 cm ao longo do osso).
export const HAND_SLOTS = Object.freeze({
  "handslot.r": Object.freeze({ y: 0.0333, rotY: Math.PI }),
  "handslot.l": Object.freeze({ y: 0.017, rotY: 0 }),
});

/**
 * Nome do nó como o GLTFLoader o deixa (PropertyBinding.sanitizeNodeName: espaço vira "_",
 * caracteres reservados "[]./:" somem).
 * @param {string} name
 * @returns {string}
 */
export function sanitizedNodeName(name) {
  return THREE.PropertyBinding.sanitizeNodeName(name);
}

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function recolorTexture(image, recolor, anisotropy) {
  const w = image.width;
  const h = image.height;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  const cw = w / ATLAS_COLS;
  const ch = h / ATLAS_ROWS;
  for (const [cell, hex] of Object.entries(recolor || {})) {
    const [c, r] = cell.split(",").map(Number);
    const x = Math.round(c * cw);
    const y = Math.round(r * ch);
    const data = ctx.getImageData(x, y, Math.round(cw), Math.round(ch));
    const px = data.data;
    let total = 0;
    for (let i = 0; i < px.length; i += 4) total += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    const mean = Math.max(1, total / (px.length / 4));
    const [tr, tg, tb] = hexToRgb(hex);
    for (let i = 0; i < px.length; i += 4) {
      const k = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) / mean;
      px[i] = Math.min(255, tr * k);
      px[i + 1] = Math.min(255, tg * k);
      px[i + 2] = Math.min(255, tb * k);
    }
    ctx.putImageData(data, x, y);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  return tex;
}

function mergeSkinnedParts(root, material) {
  const parts = [];
  root.traverse((o) => {
    if (o.isSkinnedMesh && o.visible) parts.push(o);
  });
  if (parts.length < 2) return parts[0] || null;
  const first = parts[0];
  const sameSkin = parts.every((p) => p.skeleton.bones.length === first.skeleton.bones.length && p.skeleton.bones.every((b, i) => b === first.skeleton.bones[i]) && p.bindMatrix.equals(first.bindMatrix));
  if (!sameSkin) return null;
  // O skinning ignora a matriz do nó (usa bindMatrix): só funde partes com o mesmo pai e a mesma pose de nó
  for (const p of parts) p.updateMatrix();
  if (!parts.every((p) => p.parent === first.parent && p.matrix.equals(first.matrix))) return null;
  const keep = ["position", "normal", "uv", "skinIndex", "skinWeight"];
  const geos = parts.map((p) => {
    const g = new THREE.BufferGeometry();
    for (const k of keep) if (p.geometry.attributes[k]) g.setAttribute(k, p.geometry.attributes[k]);
    if (p.geometry.index) g.setIndex(p.geometry.index);
    return g;
  });
  if (!geos.every((g) => keep.every((k) => !!g.attributes[k] === !!geos[0].attributes[k]))) return null;
  const merged = mergeGeometries(geos, false);
  if (!merged) return null;
  const mesh = new THREE.SkinnedMesh(merged, material);
  mesh.name = "Body_Merged";
  mesh.position.copy(first.position);
  mesh.quaternion.copy(first.quaternion);
  mesh.scale.copy(first.scale);
  first.parent.add(mesh);
  mesh.bind(first.skeleton, first.bindMatrix);
  for (const p of parts) p.parent.remove(p);
  return mesh;
}

export class Character {
  constructor(root, clips, body) {
    this.root = root;
    this.body = body;
    this.mixer = new THREE.AnimationMixer(root);
    this.clips = new Map(clips.map((c) => [c.name, c]));
    this.actions = new Map();
    this.current = null;
    this.currentName = "";
    this.headBone = null;
    /** @type {Map<string, THREE.Object3D>} nó do encaixe -> grupo de pose (um objeto por encaixe) */
    this.slots = new Map();
    root.traverse((o) => {
      if (o.isBone && o.name === "head") this.headBone = o;
    });
  }

  /**
   * Nó do esqueleto pelo nome original do GLB ou pelo nome sanitizado do three.
   * @param {string} name
   * @returns {THREE.Object3D | null}
   */
  findNode(name) {
    return this.root.getObjectByName(name) || this.root.getObjectByName(sanitizedNodeName(name)) || null;
  }

  /**
   * Prende um objeto (arma, escudo, tocha) no encaixe da mão. Um objeto por encaixe: o anterior sai.
   * @param {THREE.Object3D} object
   * @param {string} [slot="handslot.r"] "handslot.r" ou "handslot.l" (ou qualquer nó do esqueleto)
   * @returns {boolean} false se o esqueleto não tem esse nó
   */
  attach(object, slot = "handslot.r") {
    let holder = this.slots.get(slot);
    if (!holder) {
      const node = this.findNode(slot);
      if (!node) return false;
      holder = new THREE.Group();
      holder.name = `slot:${slot}`;
      const pose = HAND_SLOTS[slot];
      if (pose) {
        holder.position.set(0, pose.y, 0);
        holder.rotation.set(0, pose.rotY, 0);
      }
      node.add(holder);
      this.slots.set(slot, holder);
    }
    this.detach(slot);
    holder.add(object);
    object.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = false;
        o.frustumCulled = false;
      }
    });
    return true;
  }

  /**
   * Solta o que estiver no encaixe.
   * @param {string} [slot="handslot.r"]
   * @returns {THREE.Object3D | null} o objeto removido (para reaproveitar), ou null
   */
  detach(slot = "handslot.r") {
    const holder = this.slots.get(slot);
    if (!holder || holder.children.length === 0) return null;
    const obj = holder.children[0];
    holder.remove(obj);
    return obj;
  }

  /**
   * @param {string} name
   * @returns {boolean}
   */
  hasClip(name) {
    return this.clips.has(name);
  }

  /**
   * Ritmo da animação atual (pés acompanham a velocidade suavizada). Sem alocação.
   * @param {number} scale
   */
  setPlaybackRate(scale) {
    if (this.current) this.current.timeScale = scale;
  }

  action(name) {
    if (!this.actions.has(name)) {
      const clip = this.clips.get(name);
      if (!clip) return null;
      this.actions.set(name, this.mixer.clipAction(clip));
    }
    return this.actions.get(name);
  }

  // Troca de animação com crossfade. once=true toca uma vez e para no último quadro.
  play(name, { fade = 0.25, once = false, timeScale = 1 } = {}) {
    if (this.currentName === name && !once) return this.current;
    const next = this.action(name);
    if (!next) return null;
    next.reset();
    next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    next.clampWhenFinished = once;
    next.timeScale = timeScale;
    next.enabled = true;
    next.setEffectiveWeight(1);
    next.play();
    if (this.current && this.current !== next) this.current.crossFadeTo(next, fade, false);
    this.current = next;
    this.currentName = name;
    return next;
  }

  duration(name) {
    const c = this.clips.get(name);
    return c ? c.duration : 0;
  }

  update(dt) {
    this.mixer.update(dt);
  }
}

export class CharacterFactory {
  constructor() {
    this.loader = new GLTFLoader();
    this.bases = new Map();
    /** @type {Map<string, Promise<THREE.Object3D>>} cena-base de cada glTF de adereço (carregada uma vez) */
    this.props = new Map();
    /** @type {{tuneTexture: (t: THREE.Texture) => unknown, maxAnisotropy: number} | null} MaterialLibrary (opcional) */
    this.textureTuner = null;
  }

  /**
   * Liga a filtragem de texturas da MaterialLibrary (anisotropia/mipmaps do preset) em personagens e adereços.
   * @param {{tuneTexture: (t: THREE.Texture) => unknown, maxAnisotropy: number}} library
   */
  setTextureTuner(library) {
    this.textureTuner = library;
  }

  /**
   * Carrega um glTF de adereço (arma, ferramenta) uma única vez e devolve um clone novo a cada chamada.
   * Geometria e material são compartilhados entre os clones. Rejeita se a URL não existir.
   * @param {string} url
   * @returns {Promise<THREE.Object3D>}
   */
  async loadProp(url) {
    if (!this.props.has(url)) {
      const pending = this.loader.loadAsync(url).then((gltf) => {
        gltf.scene.traverse((o) => {
          if (o.isMesh && o.material && this.textureTuner) this.textureTuner.tuneTexture(o.material.map);
        });
        return gltf.scene;
      });
      // Falha não fica no cache: um build posterior pode trazer o arquivo
      pending.catch(() => this.props.delete(url));
      this.props.set(url, pending);
    }
    const base = await this.props.get(url);
    return base.clone(true);
  }

  async preload(names) {
    await Promise.all([...new Set(names)].map((n) => this.base(n)));
  }

  base(name) {
    if (!this.bases.has(name)) {
      this.bases.set(name, this.loader.loadAsync(`${CONFIG.assets.characters}${name}.glb`).then((gltf) => {
        let map = null;
        gltf.scene.traverse((o) => {
          if (o.isMesh && o.material && o.material.map && !map) map = o.material.map;
        });
        return { gltf, map };
      }));
    }
    return this.bases.get(name);
  }

  async create({ model, scale = 0.8, scaleWidth = 1, recolor = null, hide = [] }) {
    const { gltf, map } = await this.base(model);
    const root = cloneSkinned(gltf.scene);
    const aniso = this.textureTuner ? this.textureTuner.maxAnisotropy : 4;
    const texture = recolor && Object.keys(recolor).length && map ? recolorTexture(map.image, recolor, aniso) : map;
    if (this.textureTuner && texture) this.textureTuner.tuneTexture(texture);
    const material = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.78, metalness: 0 });
    const hidden = new Set(hide);
    root.traverse((o) => {
      if (hidden.has(o.name)) o.visible = false;
      if (o.isMesh) {
        o.material = material;
        o.castShadow = true;
        o.receiveShadow = false;
        o.frustumCulled = false;
      }
    });
    const merged = mergeSkinnedParts(root, material);
    if (merged) {
      merged.castShadow = true;
      merged.frustumCulled = false;
    }
    // Peças ocultas saem da cena (nada de custo de skinning para o que não aparece)
    const toRemove = [];
    root.traverse((o) => {
      if (!o.visible && o.isMesh) toRemove.push(o);
    });
    for (const o of toRemove) o.parent.remove(o);
    const holder = new THREE.Group();
    holder.add(root);
    root.scale.set(scale * scaleWidth, scale, scale * scaleWidth);
    return new Character(holder, gltf.animations, root);
  }
}
