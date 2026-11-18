import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// Fauna viva (não hostil) e utilitários de criatura compartilhados com enemies.js:
//  - loadModel: glTF estático carregado uma vez e clonado (usa factory.loadProp do characters.js quando existir);
//  - QuadrupedRig: passo/pulo procedural nos nós de perna dos animais Kenney (leg-front-left, ..., body, tail);
//  - resolveCircle / pushOutOfRect: o mesmo círculo x AABB do player.resolveCollisions, com raio próprio.
// Dados: city.json -> fauna [{id, modelo, altura, velocidade, fuga, salto, pontos}] e runtimeModels {chave: url}.
// Nada é alocado por frame: vetores de trabalho são do módulo e os laços vêm prontos do city.json.

const _loader = new GLTFLoader();
/** @type {Map<string, Promise<THREE.Object3D>>} */
const _protos = new Map();
const _box = new THREE.Box3();
const _size = new THREE.Vector3();

const LEG_NAMES = Object.freeze(["leg-front-left", "leg-front-right", "leg-back-left", "leg-back-right"]);
const FAUNA_VIEW = 85;          // além disso (da câmera) o animal some e para de pensar
const FAUNA_ANIM = 55;          // além disso ele ainda anda, mas sem animar as pernas
const FLEE_TIME = 2.6;
const FLEE_SPEED = 3.0;
const ANIMAL_RADIUS = 0.35;

/**
 * Carrega um glTF estático uma vez e devolve um clone (geometria e material compartilhados com o protótipo).
 * @param {{loadProp?: (url: string) => Promise<THREE.Object3D>} | null} factory
 * @param {string} url
 * @returns {Promise<THREE.Object3D>}
 */
export async function loadModel(factory, url) {
  if (factory && typeof factory.loadProp === "function") return factory.loadProp(url);
  if (!_protos.has(url)) _protos.set(url, _loader.loadAsync(url).then((g) => g.scene));
  const proto = await _protos.get(url);
  return proto.clone(true);
}

/**
 * Escala uniforme para que a altura do objeto seja 'height' metros (medida uma vez, na criação).
 * @param {THREE.Object3D} obj
 * @param {number} height
 * @returns {number} escala aplicada
 */
export function fitToHeight(obj, height) {
  obj.scale.setScalar(1);
  obj.updateMatrixWorld(true);
  _box.setFromObject(obj);
  _box.getSize(_size);
  const s = height / Math.max(1e-3, _size.y);
  obj.scale.setScalar(s);
  return s;
}

/**
 * Maior dimensão do objeto em metros (sem a escala do próprio objeto).
 * @param {THREE.Object3D} obj
 * @returns {number}
 */
export function maxDimension(obj) {
  obj.updateMatrixWorld(true);
  _box.setFromObject(obj);
  _box.getSize(_size);
  return Math.max(_size.x, _size.y, _size.z);
}

/**
 * Círculo x AABB contra os colisores do mundo (mesma regra do player.resolveCollisions) e limite andável.
 * @param {THREE.Vector3} pos posição a corrigir (x/z)
 * @param {number} r raio
 * @param {{collidersNear: (x: number, z: number, r: number) => Array<{minX: number, maxX: number, minZ: number, maxZ: number, minY: number, maxY: number, off?: boolean}>, bounds: {minX: number, maxX: number, minZ: number, maxZ: number}}} world
 * @returns {boolean} true se encostou em algo
 */
export function resolveCircle(pos, r, world) {
  const list = world.collidersNear(pos.x, pos.z, r + 1.5);
  let touched = false;
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (b.off || b.minY > 1.4 || b.maxY < 0.25) continue;
    if (pos.x < b.minX - r || pos.x > b.maxX + r || pos.z < b.minZ - r || pos.z > b.maxZ + r) continue;
    const cx = Math.max(b.minX, Math.min(pos.x, b.maxX));
    const cz = Math.max(b.minZ, Math.min(pos.z, b.maxZ));
    const dx = pos.x - cx;
    const dz = pos.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= r * r) continue;
    touched = true;
    if (d2 > 1e-8) {
      const d = Math.sqrt(d2);
      pos.x += (dx / d) * (r - d);
      pos.z += (dz / d) * (r - d);
    } else {
      const pl = pos.x - b.minX;
      const pr = b.maxX - pos.x;
      const pf = pos.z - b.minZ;
      const pb = b.maxZ - pos.z;
      const m = Math.min(pl, pr, pf, pb);
      if (m === pl) pos.x = b.minX - r;
      else if (m === pr) pos.x = b.maxX + r;
      else if (m === pf) pos.z = b.minZ - r;
      else pos.z = b.maxZ + r;
    }
  }
  const wb = world.bounds;
  if (pos.x < wb.minX + r) { pos.x = wb.minX + r; touched = true; }
  if (pos.x > wb.maxX - r) { pos.x = wb.maxX - r; touched = true; }
  if (pos.z < wb.minZ + r) { pos.z = wb.minZ + r; touched = true; }
  if (pos.z > wb.maxZ - r) { pos.z = wb.maxZ - r; touched = true; }
  return touched;
}

/**
 * Empurra para fora de um retângulo (ex.: city.terrain, o recinto murado) pela menor penetração.
 * @param {THREE.Vector3} pos
 * @param {{minX: number, maxX: number, minZ: number, maxZ: number}} rect
 * @param {number} pad folga além da borda (normalmente o raio)
 * @returns {boolean} true se estava dentro
 */
export function pushOutOfRect(pos, rect, pad) {
  const x0 = rect.minX - pad;
  const x1 = rect.maxX + pad;
  const z0 = rect.minZ - pad;
  const z1 = rect.maxZ + pad;
  if (pos.x <= x0 || pos.x >= x1 || pos.z <= z0 || pos.z >= z1) return false;
  const pl = pos.x - x0;
  const pr = x1 - pos.x;
  const pf = pos.z - z0;
  const pb = z1 - pos.z;
  const m = Math.min(pl, pr, pf, pb);
  if (m === pl) pos.x = x0;
  else if (m === pr) pos.x = x1;
  else if (m === pf) pos.z = z0;
  else pos.z = z1;
  return true;
}

/**
 * Ângulo amortecido pelo caminho mais curto.
 * @param {number} current
 * @param {number} target
 * @param {number} rate
 * @param {number} dt
 * @returns {number}
 */
export function turnTowards(current, target, rate, dt) {
  let diff = target - current;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  return current + diff * (1 - Math.exp(-rate * dt));
}

/** Pernas, corpo e cauda dos animais Kenney (modelos estáticos com um nó por perna, pivô no quadril). */
export class QuadrupedRig {
  /** @param {THREE.Object3D} model */
  constructor(model) {
    /** @type {THREE.Object3D[]} */
    this.legs = [];
    for (const name of LEG_NAMES) {
      const leg = model.getObjectByName(name);
      if (leg) this.legs.push(leg);
    }
    this.body = model.getObjectByName("body") || null;
    this.tail = model.getObjectByName("tail") || null;
    this.bodyY = this.body ? this.body.position.y : 0;
    this.valid = this.legs.length === 4;
  }

  /**
   * Passo trotado: diagonais em fase (dianteira esquerda com traseira direita).
   * @param {number} phase fase do passo (rad)
   * @param {number} amp amplitude da perna (rad)
   * @param {number} bob subida do corpo por passada (unidades do modelo)
   */
  step(phase, amp, bob) {
    if (!this.valid) return;
    const s = Math.sin(phase) * amp;
    this.legs[0].rotation.x = s;
    this.legs[3].rotation.x = s;
    this.legs[1].rotation.x = -s;
    this.legs[2].rotation.x = -s;
    if (this.body) this.body.position.y = this.bodyY + Math.abs(Math.sin(phase)) * bob;
    if (this.tail) this.tail.rotation.y = Math.sin(phase * 0.5) * 0.35;
  }

  /**
   * Pulo: patas dianteiras e traseiras juntas (coelho, bote do lobo).
   * @param {number} k 0 no chão .. 1 no alto
   */
  hop(k) {
    if (!this.valid) return;
    this.legs[0].rotation.x = -0.6 * k;
    this.legs[1].rotation.x = -0.6 * k;
    this.legs[2].rotation.x = 0.7 * k;
    this.legs[3].rotation.x = 0.7 * k;
  }

  /** Volta à pose neutra. */
  rest() {
    if (!this.valid) return;
    for (let i = 0; i < 4; i++) this.legs[i].rotation.x = 0;
    if (this.body) this.body.position.y = this.bodyY;
  }
}

const FAUNA_STATE = Object.freeze({ WALK: 0, GRAZE: 1, FLEE: 2 });

/**
 * @typedef {{id: string, modelo: string, altura: number, velocidade: number, fuga: number, salto: boolean, pontos: number[][]}} FaunaSpec
 */

class Animal {
  /**
   * @param {FaunaSpec} spec
   * @param {THREE.Object3D} model
   */
  constructor(spec, model) {
    this.spec = spec;
    this.root = new THREE.Group();
    this.root.name = `Fauna_${spec.id}`;
    this.tilt = new THREE.Group();
    this.root.add(this.tilt);
    this.tilt.add(model);
    fitToHeight(model, spec.altura);
    model.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = false;
      }
    });
    this.rig = new QuadrupedRig(model);
    this.height = spec.altura;
    this.idx = 0;
    this.state = FAUNA_STATE.WALK;
    this.timer = 0;
    this.phase = Math.random() * 6.28;
    this.yaw = Math.random() * 6.28;
    this.targetYaw = this.yaw;
    this.speed = 0;
    this.stuck = 0;
    const p0 = spec.pontos[0];
    this.root.position.set(p0[0], 0, p0[1]);
    this.idx = spec.pontos.length > 1 ? 1 : 0;
  }
}

/** Animais itinerantes: andam pelo laço, param para pastar e fogem do jogador. */
export class FaunaSystem {
  /**
   * @param {{scene: THREE.Scene, world: {city: object, collidersNear: Function, bounds: object}, factory?: object | null}} opts
   */
  constructor({ scene, world, factory = null }) {
    this.scene = scene;
    this.world = world;
    this.factory = factory;
    /** @type {Animal[]} */
    this.animals = [];
    this.wallRect = world.city.terrain;
  }

  /** Carrega os modelos de runtimeModels e cria os animais de city.fauna. */
  async init() {
    const specs = this.world.city.fauna || [];
    const urls = this.world.city.runtimeModels || {};
    for (const spec of specs) {
      const url = urls[spec.modelo];
      if (!url || !spec.pontos || !spec.pontos.length) continue;
      try {
        const model = await loadModel(this.factory, url);
        const a = new Animal(spec, model);
        this.scene.add(a.root);
        this.animals.push(a);
      } catch (err) {
        console.warn(`[Alvor] Fauna ${spec.id} indisponível:`, err);
      }
    }
  }

  /**
   * @param {number} dt
   * @param {number} elapsed
   * @param {THREE.Vector3} playerPos
   * @param {THREE.Camera} camera
   */
  update(dt, elapsed, playerPos, camera) {
    const cam = camera.position;
    const view2 = FAUNA_VIEW * FAUNA_VIEW;
    const anim2 = FAUNA_ANIM * FAUNA_ANIM;
    for (let i = 0; i < this.animals.length; i++) {
      const a = this.animals[i];
      const pos = a.root.position;
      const dc2 = (pos.x - cam.x) ** 2 + (pos.z - cam.z) ** 2;
      if (dc2 > view2) {
        if (a.root.visible) a.root.visible = false;
        continue;
      }
      if (!a.root.visible) a.root.visible = true;
      this.think(a, dt, playerPos);
      this.move(a, dt);
      if (dc2 < anim2) this.animate(a, dt, elapsed);
    }
  }

  /**
   * @param {Animal} a
   * @param {number} dt
   * @param {THREE.Vector3} playerPos
   */
  think(a, dt, playerPos) {
    const spec = a.spec;
    const pos = a.root.position;
    const dxp = pos.x - playerPos.x;
    const dzp = pos.z - playerPos.z;
    const dp2 = dxp * dxp + dzp * dzp;
    a.timer -= dt;
    if (dp2 < spec.fuga * spec.fuga) {
      // Foge na direção oposta ao jogador (renova enquanto ele estiver perto)
      a.state = FAUNA_STATE.FLEE;
      a.timer = FLEE_TIME;
      a.targetYaw = Math.atan2(dxp, dzp);
      a.speed = spec.velocidade * FLEE_SPEED;
      return;
    }
    if (a.state === FAUNA_STATE.FLEE) {
      if (a.timer > 0) return;
      // Passado o susto, retoma o laço pelo ponto mais próximo
      let best = 0;
      let bd = Infinity;
      for (let k = 0; k < spec.pontos.length; k++) {
        const p = spec.pontos[k];
        const d = (p[0] - pos.x) ** 2 + (p[1] - pos.z) ** 2;
        if (d < bd) { bd = d; best = k; }
      }
      a.idx = best;
      a.state = FAUNA_STATE.WALK;
    }
    if (a.state === FAUNA_STATE.GRAZE) {
      a.speed = 0;
      if (a.timer <= 0) {
        a.state = FAUNA_STATE.WALK;
        a.idx = (a.idx + 1) % spec.pontos.length;
      }
      return;
    }
    const target = spec.pontos[a.idx];
    const dx = target[0] - pos.x;
    const dz = target[1] - pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < 0.36 || a.stuck > 2.5) {
      a.stuck = 0;
      a.state = FAUNA_STATE.GRAZE;
      a.timer = 2 + Math.random() * 4;
      a.speed = 0;
      return;
    }
    a.targetYaw = Math.atan2(dx, dz);
    a.speed = spec.velocidade;
  }

  /**
   * @param {Animal} a
   * @param {number} dt
   */
  move(a, dt) {
    if (a.speed <= 0) return;
    a.yaw = turnTowards(a.yaw, a.targetYaw, a.state === FAUNA_STATE.FLEE ? 9 : 4, dt);
    const pos = a.root.position;
    const px = pos.x;
    const pz = pos.z;
    pos.x += Math.sin(a.yaw) * a.speed * dt;
    pos.z += Math.cos(a.yaw) * a.speed * dt;
    resolveCircle(pos, ANIMAL_RADIUS, this.world);
    pushOutOfRect(pos, this.wallRect, ANIMAL_RADIUS + 1.0);
    const moved = Math.hypot(pos.x - px, pos.z - pz);
    a.stuck = moved < a.speed * dt * 0.3 ? a.stuck + dt : Math.max(0, a.stuck - dt);
    a.root.rotation.y = a.yaw;
  }

  /**
   * @param {Animal} a
   * @param {number} dt
   * @param {number} elapsed
   */
  animate(a, dt, elapsed) {
    const moving = a.speed > 0.05;
    if (a.spec.salto) {
      // Coelho: pulinhos (o corpo sobe e as patas encolhem no ar)
      if (moving) a.phase += dt * (5 + a.speed * 2.2);
      const k = moving ? Math.abs(Math.sin(a.phase)) : 0;
      a.tilt.position.y = k * a.height * 0.35;
      a.tilt.rotation.x = moving ? -Math.cos(a.phase) * 0.18 : 0;
      a.rig.hop(k);
      return;
    }
    if (moving) {
      a.phase += dt * (2.2 + a.speed * 2.6);
      a.rig.step(a.phase, Math.min(0.75, 0.35 + a.speed * 0.12), 0.05);
      a.tilt.rotation.x += (0 - a.tilt.rotation.x) * Math.min(1, dt * 6);
    } else {
      a.rig.rest();
      // Pastando: cabeça baixa com um leve vaivém
      const graze = a.state === FAUNA_STATE.GRAZE ? 0.22 + Math.sin(elapsed * 1.7 + a.phase) * 0.05 : 0;
      a.tilt.rotation.x += (graze - a.tilt.rotation.x) * Math.min(1, dt * 3);
    }
    a.tilt.position.y = 0;
  }
}
