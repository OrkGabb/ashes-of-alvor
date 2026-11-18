import * as THREE from "three";
import { ANIM, CONFIG } from "./config.js";

// Combate do Desperto: golpe corpo-a-corpo em arco, três magias (Disparo Arcano, Pulso Rúnico, Luz
// Restauradora), esquiva com invulnerabilidade, dano recebido, desmaio. Hitstop, empurrão, números de dano
// flutuantes, rastro do golpe, partículas e SFX ficam aqui.
//
// Desempenho: tudo é pré-alocado no construtor (pool de projéteis, campo de partículas, rastro, anel,
// registros de números). Nada de Vector3/arrays/closures por quadro. Sem PointLight nova: a contagem de
// luzes é fixa (perf.js/atmosphere) e mudar a quantidade recompilaria todos os shaders; o brilho é aditivo.

const DEG = Math.PI / 180;
const INTENT_NONE = 0;
const INTENT_MELEE = 1;
const INTENT_SPELL = 2;
const INTENT_DODGE = 3;
const TRAIL_SEGMENTS = 18;
const PROJECTILE_HEIGHT = 1.15;

const _proj = new THREE.Vector3();

// ------------------------------------------------------------------------------------------------
// Geometria pura (sem THREE): testável em node
// ------------------------------------------------------------------------------------------------

/**
 * Alvo dentro do arco do golpe? Alcance medido até a borda do alvo; o arco ganha a meia-largura
 * angular do alvo (um alvo grande "de raspão" na borda do arco é atingido). Colado = sempre acerta.
 * @param {number} px origem X (jogador)
 * @param {number} pz origem Z
 * @param {number} fx direção do golpe X (não precisa ser unitária)
 * @param {number} fz direção do golpe Z
 * @param {number} tx centro do alvo X
 * @param {number} tz centro do alvo Z
 * @param {number} targetRadius raio do alvo
 * @param {number} range alcance da arma (m)
 * @param {number} arcDeg abertura total do arco (graus)
 * @returns {boolean}
 */
export function inMeleeArc(px, pz, fx, fz, tx, tz, targetRadius, range, arcDeg) {
  const dx = tx - px;
  const dz = tz - pz;
  const dist = Math.hypot(dx, dz);
  if (dist - targetRadius > range) return false;
  if (dist <= targetRadius + 0.25) return true;
  const flen = Math.hypot(fx, fz) || 1;
  const cos = (dx * fx + dz * fz) / (dist * flen);
  const ang = Math.acos(Math.max(-1, Math.min(1, cos)));
  const slack = Math.asin(Math.min(1, targetRadius / dist));
  return ang <= arcDeg * 0.5 * DEG + slack;
}

/**
 * Primeiro contato de um segmento P0->P1 com um círculo (XZ).
 * @param {number} x0
 * @param {number} z0
 * @param {number} x1
 * @param {number} z1
 * @param {number} cx
 * @param {number} cz
 * @param {number} r
 * @returns {number} fração t em [0, 1] do segmento, ou -1 se não toca
 */
export function segmentCircleHit(x0, z0, x1, z1, cx, cz, r) {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const fx = x0 - cx;
  const fz = z0 - cz;
  const c = fx * fx + fz * fz - r * r;
  if (c <= 0) return 0;
  const a = dx * dx + dz * dz;
  if (a < 1e-12) return -1;
  const b = 2 * (fx * dx + fz * dz);
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t >= 0 && t <= 1 ? t : -1;
}

/**
 * Primeiro contato de um segmento P0->P1 com um retângulo XZ (método das fatias).
 * @param {number} x0
 * @param {number} z0
 * @param {number} x1
 * @param {number} z1
 * @param {number} minX
 * @param {number} minZ
 * @param {number} maxX
 * @param {number} maxZ
 * @returns {number} fração t em [0, 1], ou -1
 */
export function segmentAabbHit(x0, z0, x1, z1, minX, minZ, maxX, maxZ) {
  const dx = x1 - x0;
  const dz = z1 - z0;
  let tmin = 0;
  let tmax = 1;
  if (Math.abs(dx) < 1e-9) {
    if (x0 < minX || x0 > maxX) return -1;
  } else {
    let ta = (minX - x0) / dx;
    let tb = (maxX - x0) / dx;
    if (ta > tb) {
      const s = ta;
      ta = tb;
      tb = s;
    }
    if (ta > tmin) tmin = ta;
    if (tb < tmax) tmax = tb;
    if (tmin > tmax) return -1;
  }
  if (Math.abs(dz) < 1e-9) {
    if (z0 < minZ || z0 > maxZ) return -1;
  } else {
    let ta = (minZ - z0) / dz;
    let tb = (maxZ - z0) / dz;
    if (ta > tb) {
      const s = ta;
      ta = tb;
      tb = s;
    }
    if (ta > tmin) tmin = ta;
    if (tb < tmax) tmax = tb;
    if (tmin > tmax) return -1;
  }
  return tmin;
}

/**
 * Ângulo do corpo (rotation.y, frente = (sin, cos)) que olha na direção da mira da câmera.
 * @param {number} yaw Player.yaw
 * @returns {number}
 */
export function facingFromYaw(yaw) {
  return Math.atan2(-Math.sin(yaw), -Math.cos(yaw));
}

/**
 * Clipe de esquiva conforme a direção do dash em relação à frente do corpo.
 * @param {number} dirX
 * @param {number} dirZ
 * @param {number} facing rotation.y do corpo
 * @returns {string}
 */
export function dodgeClip(dirX, dirZ, facing) {
  const fx = Math.sin(facing);
  const fz = Math.cos(facing);
  const dotF = dirX * fx + dirZ * fz;
  const dotR = dirX * -fz + dirZ * fx;
  if (Math.abs(dotF) >= Math.abs(dotR)) return dotF >= 0 ? ANIM.esquivaFrente : ANIM.esquivaTras;
  return dotR > 0 ? ANIM.esquivaDireita : ANIM.esquivaEsquerda;
}

// ------------------------------------------------------------------------------------------------
// Visuais pré-alocados
// ------------------------------------------------------------------------------------------------

let glowTexture = null;

/** @returns {THREE.Texture} brilho radial compartilhado (partículas, projéteis, cura) */
function getGlowTexture() {
  if (glowTexture) return glowTexture;
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.25, "rgba(255,255,255,0.75)");
  grad.addColorStop(0.6, "rgba(255,255,255,0.18)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  glowTexture = new THREE.CanvasTexture(c);
  glowTexture.colorSpace = THREE.SRGBColorSpace;
  return glowTexture;
}

// Partículas aditivas num único THREE.Points (1 draw call). Cor esmaece até preto (= invisível no aditivo).
class ParticleField {
  /**
   * @param {THREE.Scene} scene
   * @param {number} capacity
   * @param {number} size tamanho do ponto (m, com atenuação)
   */
  constructor(scene, capacity, size) {
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.base = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.grav = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    for (let i = 0; i < capacity; i++) this.pos[i * 3 + 1] = -1e4;
    this.cursor = 0;
    this.alive = 0;
    this.dirty = false;
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3);
    this.colAttr = new THREE.BufferAttribute(this.col, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", this.posAttr);
    geo.setAttribute("color", this.colAttr);
    const mat = new THREE.PointsMaterial({
      size,
      map: getGlowTexture(),
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.points.name = "CombatParticles";
    scene.add(this.points);
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} vx
   * @param {number} vy
   * @param {number} vz
   * @param {number} life s
   * @param {number} r 0..1
   * @param {number} g 0..1
   * @param {number} b 0..1
   * @param {number} [grav=0] m/s² (negativo cai)
   * @param {number} [drag=0] 1/s
   */
  emit(x, y, z, vx, vy, vz, life, r, g, b, grav = 0, drag = 0) {
    const i = this.cursor;
    this.cursor = (i + 1) % this.capacity;
    if (this.life[i] <= 0) this.alive++;
    const k = i * 3;
    this.pos[k] = x;
    this.pos[k + 1] = y;
    this.pos[k + 2] = z;
    this.vel[k] = vx;
    this.vel[k + 1] = vy;
    this.vel[k + 2] = vz;
    this.base[k] = r;
    this.base[k + 1] = g;
    this.base[k + 2] = b;
    this.col[k] = r;
    this.col[k + 1] = g;
    this.col[k + 2] = b;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.grav[i] = grav;
    this.drag[i] = drag;
    this.dirty = true;
  }

  /**
   * Explosão esférica (impacto, faíscas).
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} count
   * @param {number} speed
   * @param {number} life
   * @param {number} r
   * @param {number} g
   * @param {number} b
   * @param {number} [grav=0]
   */
  burst(x, y, z, count, speed, life, r, g, b, grav = 0) {
    for (let n = 0; n < count; n++) {
      const u = Math.random() * 2 - 1;
      const th = Math.random() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      const v = speed * (0.4 + Math.random() * 0.6);
      this.emit(x, y, z, Math.cos(th) * s * v, u * v, Math.sin(th) * s * v, life * (0.6 + Math.random() * 0.4), r, g, b, grav, 3);
    }
  }

  /** @param {number} dt */
  update(dt) {
    if (this.alive <= 0 && !this.dirty) return;
    const pos = this.pos;
    const vel = this.vel;
    const col = this.col;
    let alive = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) continue;
      const k = i * 3;
      const l = this.life[i] - dt;
      if (l <= 0) {
        this.life[i] = 0;
        pos[k + 1] = -1e4;
        col[k] = 0;
        col[k + 1] = 0;
        col[k + 2] = 0;
        continue;
      }
      alive++;
      this.life[i] = l;
      const d = Math.max(0, 1 - this.drag[i] * dt);
      vel[k] *= d;
      vel[k + 1] = vel[k + 1] * d + this.grav[i] * dt;
      vel[k + 2] *= d;
      pos[k] += vel[k] * dt;
      pos[k + 1] += vel[k + 1] * dt;
      pos[k + 2] += vel[k + 2] * dt;
      const f = l / this.maxLife[i];
      const a = f * f;
      col[k] = this.base[k] * a;
      col[k + 1] = this.base[k + 1] * a;
      col[k + 2] = this.base[k + 2] * a;
    }
    this.alive = alive;
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.dirty = alive > 0;
  }
}

// Rastro do golpe: fita em arco (malha única pré-alocada, cor com alfa por vértice, aditiva)
class SwingTrail {
  /** @param {THREE.Scene} scene */
  constructor(scene) {
    const verts = (TRAIL_SEGMENTS + 1) * 2;
    this.positions = new Float32Array(verts * 3);
    this.colors = new Float32Array(verts * 4);
    const index = [];
    for (let i = 0; i < TRAIL_SEGMENTS; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.positions, 3);
    this.colAttr = new THREE.BufferAttribute(this.colors, 4);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", this.posAttr);
    geo.setAttribute("color", this.colAttr);
    geo.setIndex(index);
    this.mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide })
    );
    this.mesh.rotation.order = "YXZ";
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 4;
    this.mesh.name = "SwingTrail";
    scene.add(this.mesh);
    this.t = 0;
    this.dur = 0.3;
    this.arc = 1.8;
    this.inner = 0.45;
    this.outer = 2;
    this.dir = 1;
    this.r = 1;
    this.g = 1;
    this.b = 1;
  }

  /**
   * @param {number} facing rotation.y do corpo
   * @param {number} arcRad abertura (rad)
   * @param {number} outer raio externo (m)
   * @param {number} tilt inclinação do plano (rad, golpe diagonal)
   * @param {number} dir +1 da direita para a esquerda, -1 o contrário
   * @param {number} dur s
   * @param {number} r
   * @param {number} g
   * @param {number} b
   */
  start(facing, arcRad, outer, tilt, dir, dur, r, g, b) {
    this.t = 0;
    this.dur = dur;
    this.arc = arcRad;
    this.inner = CONFIG.combat.melee.trailInner;
    this.outer = outer;
    this.dir = dir;
    this.r = r;
    this.g = g;
    this.b = b;
    this.mesh.rotation.set(0, facing, tilt);
    this.mesh.visible = true;
  }

  stop() {
    this.mesh.visible = false;
  }

  /**
   * @param {number} dt
   * @param {THREE.Vector3} anchor posição do jogador (pés)
   */
  update(dt, anchor) {
    if (!this.mesh.visible) return;
    this.t += dt;
    const p = this.t / this.dur;
    if (p >= 1) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.position.set(anchor.x, anchor.y + CONFIG.combat.melee.trailHeight, anchor.z);
    const head = 1 - (1 - Math.min(1, p * 1.4)) * (1 - Math.min(1, p * 1.4));
    const tail = Math.max(0, head - 0.6);
    const fade = 1 - p;
    const pos = this.positions;
    const col = this.colors;
    for (let i = 0; i <= TRAIL_SEGMENTS; i++) {
      const s = i / TRAIL_SEGMENTS;
      const u = tail + (head - tail) * s;
      const ang = this.dir * (u - 0.5) * this.arc;
      const sx = Math.sin(ang);
      const cz = Math.cos(ang);
      const k = i * 6;
      pos[k] = sx * this.inner;
      pos[k + 1] = 0;
      pos[k + 2] = cz * this.inner;
      pos[k + 3] = sx * this.outer;
      pos[k + 4] = 0;
      pos[k + 5] = cz * this.outer;
      const a = s * s * fade;
      const c = i * 8;
      col[c] = this.r;
      col[c + 1] = this.g;
      col[c + 2] = this.b;
      col[c + 3] = a * 0.15;
      col[c + 4] = this.r;
      col[c + 5] = this.g;
      col[c + 6] = this.b;
      col[c + 7] = a * 0.85;
    }
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
  }
}

// ------------------------------------------------------------------------------------------------
// Sistema de combate
// ------------------------------------------------------------------------------------------------

export class CombatSystem {
  /**
   * @param {{scene: THREE.Scene, camera: THREE.Camera, player: import("./player.js").Player, stats: object,
   *   game: object, audio: object, hud: object, data: object}} opts
   */
  constructor({ scene, camera, player, stats, game, audio, hud, data }) {
    this.scene = scene;
    this.camera = camera;
    this.player = player;
    this.stats = stats;
    this.game = game;
    this.audio = audio;
    this.hud = hud;
    this.data = data;
    /** @type {{targets: Array<object>, engaged: boolean, setPlayerTarget: (t: object) => void} | null} */
    this.enemies = null;
    /** @type {(() => void) | null} */
    this.onDeath = null;

    const cc = CONFIG.combat;
    this.spells = cc.spells;
    this.selected = 0;
    this.spellCd = new Float32Array(this.spells.length);
    this.meleeCd = 0;
    this.castLock = 0;
    this.dodgeCd = 0;
    this.invuln = 0;
    this.combatTimer = 0;
    this.hitstop = 0;
    this.comboStep = 0;
    this.lastSwingAt = -10;
    this.clock = 0;
    this.dead = false;
    this.deathTimer = 0;
    this.deathNotified = false;
    this.toastCooldown = 0;
    this.width = 1;
    this.height = 1;

    this.intent = INTENT_NONE;
    this.intentSpell = 0;
    this.intentAge = 0;

    // Golpe em andamento (um por vez)
    this.swing = { active: false, t: 0, hitDone: false, facing: 0, mul: 1, style: "sword", dmg: 0, range: 2, arc: 90 };
    // Pulso e cura em andamento
    this.pulse = { active: false, t: 0, applied: false, x: 0, z: 0, y: 0, dmg: 0, radius: 4, knock: 6, dur: 0.5, delay: 0.1 };
    this.heal = { active: false, t: 0, dur: 1.2, emit: 0 };

    // Visuais pré-alocados
    this.particles = new ParticleField(scene, cc.particles, 0.22);
    this.trail = new SwingTrail(scene);
    const glow = getGlowTexture();
    this.boltMaterial = new THREE.SpriteMaterial({ map: glow, color: 0xa8c8ff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.projectiles = [];
    for (let i = 0; i < cc.projectiles; i++) {
      const sprite = new THREE.Sprite(this.boltMaterial);
      sprite.scale.set(0.55, 0.55, 0.55);
      sprite.visible = false;
      sprite.renderOrder = 6;
      scene.add(sprite);
      this.projectiles.push({ active: false, x: 0, y: 0, z: 0, dx: 0, dz: 1, speed: 20, travelled: 0, maxDist: 20, dmg: 0, knock: 0, radius: 0.3, emitAcc: 0, sprite });
    }
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.86, 1, 64),
      new THREE.MeshBasicMaterial({ color: 0x86b4ff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide })
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.visible = false;
    this.ring.renderOrder = 4;
    scene.add(this.ring);
    this.healGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: 0x9ff0a0, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.healGlow.visible = false;
    this.healGlow.scale.set(2.2, 2.2, 2.2);
    scene.add(this.healGlow);

    // Números flutuantes: registros fixos (o DOM vem do pool do Hud)
    this.numbers = [];
    for (let i = 0; i < cc.numbers.pool; i++) this.numbers.push({ active: false, x: 0, y: 0, z: 0, t: 0, drift: 0, slot: -1 });

    // Alvo estável entregue ao EnemySystem
    const self = this;
    this.playerTarget = {
      position: player.position,
      radius: CONFIG.player.radius,
      get invulnerable() {
        return self.invuln > 0 || self.dead;
      },
      get dead() {
        return self.dead;
      },
      hurt(amount, fromX, fromZ) {
        self.hurt(amount, fromX, fromZ);
      },
    };

    this.bindInput();
    player.bindEquipment(game);
  }

  // ---- Integração ---------------------------------------------------------------------------------

  /**
   * Liga o sistema de inimigos (alvos para golpes/magias) e entrega o alvo do jogador.
   * @param {{targets: Array<object>, engaged: boolean, setPlayerTarget: (t: object) => void}} enemies
   */
  setEnemies(enemies) {
    this.enemies = enemies;
    if (enemies && enemies.setPlayerTarget) enemies.setPlayerTarget(this.playerTarget);
  }

  /** @returns {boolean} golpeou/foi golpeado há pouco ou algum inimigo está engajado */
  get inCombat() {
    return this.combatTimer > 0 || Boolean(this.enemies && this.enemies.engaged);
  }

  /** @returns {number} mana/s extra da arma equipada */
  get manaRegenBonus() {
    return this.weaponStats().regen_mana || 0;
  }

  /**
   * dt com hitstop aplicado (consome o hitstop com o tempo real). Chamar uma vez por quadro, antes de
   * player.update / combat.update / enemies.update, e passar o resultado a eles.
   * @param {number} dt
   * @returns {number}
   */
  scaleDt(dt) {
    if (this.hitstop <= 0) return dt;
    this.hitstop -= dt;
    return dt * CONFIG.combat.hitstop.scale;
  }

  /** Limpa o desmaio depois que o app.js reposicionou o jogador e recarregou o status. */
  revive() {
    this.dead = false;
    this.deathNotified = false;
    this.deathTimer = 0;
    this.player.setDead(false);
    this.hud.setFainted(false);
    this.invuln = CONFIG.combat.hurt.reviveGrace;
    this.combatTimer = 0;
    this.meleeCd = 0;
    this.castLock = 0;
    this.dodgeCd = 0;
    this.intent = INTENT_NONE;
    this.swing.active = false;
    this.trail.stop();
    for (let i = 0; i < this.spellCd.length; i++) this.spellCd[i] = 0;
  }

  // ---- Entrada (eventos só enfileiram intenção; a execução é no update) -----------------------------

  bindInput() {
    const dom = this.player.dom;
    dom.addEventListener("contextmenu", (e) => e.preventDefault());
    dom.addEventListener("mousedown", (e) => {
      // O primeiro clique sem pointer lock só trava o ponteiro (player.js)
      if (!this.player.pointerLocked || this.player.inputBlocked) return;
      if (e.button === 0) this.queue(INTENT_MELEE, 0);
      else if (e.button === 2) {
        e.preventDefault();
        this.queue(INTENT_SPELL, this.selected);
      }
    });
    window.addEventListener("keydown", (e) => {
      if (this.player.inputBlocked || e.repeat) return;
      const a = document.activeElement;
      if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA")) return;
      let spell = -1;
      if (e.code === "Digit1" || e.code === "Numpad1") spell = 0;
      else if (e.code === "Digit2" || e.code === "Numpad2") spell = 1;
      else if (e.code === "Digit3" || e.code === "Numpad3") spell = 2;
      if (spell >= 0 && spell < this.spells.length) {
        this.selected = spell;
        this.queue(INTENT_SPELL, spell);
      } else if (e.code === "Space") {
        e.preventDefault();
        this.queue(INTENT_DODGE, 0);
      }
    });
  }

  /**
   * @param {number} kind INTENT_*
   * @param {number} spell índice da magia (INTENT_SPELL)
   */
  queue(kind, spell) {
    this.intent = kind;
    this.intentSpell = spell;
    this.intentAge = 0;
  }

  // ---- Arma ---------------------------------------------------------------------------------------

  /** @returns {string | null} id da arma equipada */
  weaponId() {
    const eq = this.game.equipado;
    return (eq && eq.arma) || null;
  }

  /** @returns {{dano_corpo: number, alcance: number, arco_graus: number, recarga: number, poder_magico: number, regen_mana: number}} */
  weaponStats() {
    const id = this.weaponId();
    const def = id ? this.game.items[id] : null;
    return (def && def.combate) || CONFIG.combat.unarmed;
  }

  /** @returns {"sword" | "staff" | "unarmed"} */
  weaponStyle() {
    const id = this.weaponId();
    if (!id) return "unarmed";
    return CONFIG.combat.styles[id] || "sword";
  }

  // ---- Laço ---------------------------------------------------------------------------------------

  /**
   * @param {number} dt (já com scaleDt aplicado)
   * @param {number} elapsed
   * @param {object} zone
   * @param {boolean} blocked diálogo/janela/mapa aberto
   */
  update(dt, elapsed, zone, blocked) {
    this.clock += dt;
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.meleeCd = Math.max(0, this.meleeCd - dt);
    this.castLock = Math.max(0, this.castLock - dt);
    this.dodgeCd = Math.max(0, this.dodgeCd - dt);
    this.invuln = Math.max(0, this.invuln - dt);
    this.combatTimer = Math.max(0, this.combatTimer - dt);
    this.toastCooldown = Math.max(0, this.toastCooldown - dt);
    for (let i = 0; i < this.spellCd.length; i++) this.spellCd[i] = Math.max(0, this.spellCd[i] - dt);

    if (!this.dead && this.stats.dead) this.die();
    if (this.dead) {
      this.intent = INTENT_NONE;
      this.deathTimer -= dt;
      if (this.deathTimer <= 0 && !this.deathNotified) {
        this.deathNotified = true;
        if (this.onDeath) this.onDeath();
      }
    } else if (this.intent !== INTENT_NONE) {
      this.intentAge += dt;
      if (blocked || this.player.inputBlocked || this.player.seat || this.intentAge > CONFIG.combat.inputBuffer) this.intent = INTENT_NONE;
      else this.tryIntent();
    }

    this.updateSwing(dt);
    this.updateProjectiles(dt);
    this.updatePulse(dt);
    this.updateHeal(dt);
    this.trail.update(dt, this.player.position);
    this.particles.update(dt);
    this.updateNumbers(dt);
    this.renderHotbar();
  }

  tryIntent() {
    let done = false;
    if (this.intent === INTENT_MELEE) {
      if (this.player.dashing || this.meleeCd > 0 || this.castLock > 0) return;
      done = true;
      this.startMelee();
    } else if (this.intent === INTENT_SPELL) {
      if (this.player.dashing || this.castLock > 0 || this.spellCd[this.intentSpell] > 0) return;
      done = true;
      this.castSpell(this.intentSpell);
    } else if (this.intent === INTENT_DODGE) {
      if (this.player.dashing || this.dodgeCd > 0) return;
      done = true;
      this.startDodge();
    }
    if (done) this.intent = INTENT_NONE;
  }

  renderHotbar() {
    const mana = this.stats.mana;
    for (let i = 0; i < this.spells.length; i++) {
      const sp = this.spells[i];
      this.hud.setSpellState(i, this.spellCd[i] / sp.recarga, mana >= sp.custo, i === this.selected);
    }
  }

  /**
   * @param {string} text
   */
  warn(text) {
    if (this.toastCooldown > 0) return;
    this.toastCooldown = 1.2;
    this.hud.toast(text, "warn");
    this.audio.cue("error");
  }

  // ---- Mira ---------------------------------------------------------------------------------------

  /**
   * Direção do ataque: a mira da câmera, puxada para o inimigo vivo mais próximo dentro do cone.
   * @param {number} range m
   * @param {number} coneDeg abertura total do cone
   * @returns {number} ângulo do corpo (rotation.y)
   */
  aimFacing(range, coneDeg) {
    const base = facingFromYaw(this.player.yaw);
    const list = this.enemies ? this.enemies.targets : null;
    if (!list) return base;
    const p = this.player.position;
    const fx = Math.sin(base);
    const fz = Math.cos(base);
    const half = coneDeg * 0.5 * DEG;
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e.alive) continue;
      const ep = e.root.position;
      const dx = ep.x - p.x;
      const dz = ep.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d - e.radius > range || d < 1e-4) continue;
      const ang = Math.acos(Math.max(-1, Math.min(1, (dx * fx + dz * fz) / d)));
      if (ang > half) continue;
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    if (!best) return base;
    return Math.atan2(best.root.position.x - p.x, best.root.position.z - p.z);
  }

  // ---- Golpe corpo-a-corpo ------------------------------------------------------------------------

  startMelee() {
    const w = this.weaponStats();
    const style = this.weaponStyle();
    const m = CONFIG.combat.melee;
    this.comboStep = this.clock - this.lastSwingAt < m.comboWindow ? (this.comboStep + 1) % 3 : 0;
    this.lastSwingAt = this.clock;
    const facing = this.aimFacing(w.alcance + m.assistRange, m.assistArc);
    this.player.faceAngle(facing);
    const clips = style === "staff" ? ANIM.golpeCajado : style === "unarmed" ? ANIM.golpeMao : ANIM.golpeEspada;
    const clip = clips[this.comboStep % clips.length];
    const clipDur = this.player.character ? this.player.character.duration(clip) : 1;
    const timeScale = Math.max(1, Math.min(2.2, clipDur / (w.recarga * 1.5)));
    this.player.playAction(clip, w.recarga * m.lockFraction + 0.2, timeScale);
    this.player.slow(w.recarga * 0.8, m.moveFactor);
    this.meleeCd = w.recarga;
    this.combatTimer = Math.max(this.combatTimer, 1.5);
    const s = this.swing;
    s.active = true;
    s.t = 0;
    s.hitDone = false;
    s.facing = facing;
    s.style = style;
    s.range = w.alcance;
    s.arc = w.arco_graus;
    s.mul = this.comboStep === 2 ? m.comboBonus : 1;
    s.dmg = w.dano_corpo;
    const tilt = this.comboStep === 0 ? 0.55 : this.comboStep === 1 ? -0.1 : -0.9;
    const dir = this.comboStep === 1 ? -1 : 1;
    if (style === "staff") this.trail.start(facing, w.arco_graus * DEG, w.alcance * 0.95, tilt, dir, m.swingTime, 0.55, 0.75, 1.0);
    else if (style === "sword") this.trail.start(facing, w.arco_graus * DEG, w.alcance * 0.95, tilt, dir, m.swingTime, 1.0, 0.9, 0.7);
    else this.trail.stop();
    this.audio.fx("swordSwing", this.player.position, style === "unarmed" ? 0.6 : 1);
  }

  /** @param {number} dt */
  updateSwing(dt) {
    const s = this.swing;
    if (!s.active) return;
    s.t += dt;
    if (!s.hitDone && s.t >= CONFIG.combat.melee.impactAt) {
      s.hitDone = true;
      this.resolveMelee();
    }
    if (s.t > CONFIG.combat.melee.swingTime + 0.1) s.active = false;
  }

  resolveMelee() {
    const s = this.swing;
    const list = this.enemies ? this.enemies.targets : null;
    if (!list) return;
    const m = CONFIG.combat.melee;
    const p = this.player.position;
    const fx = Math.sin(s.facing);
    const fz = Math.cos(s.facing);
    let hits = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e.alive) continue;
      const ep = e.root.position;
      if (!inMeleeArc(p.x, p.z, fx, fz, ep.x, ep.z, e.radius, s.range, s.arc)) continue;
      const crit = s.mul > 1;
      const amount = Math.max(1, Math.round(s.dmg * s.mul * (1 + (Math.random() * 2 - 1) * m.variance)));
      let dx = ep.x - p.x;
      let dz = ep.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d > 1e-4) {
        dx /= d;
        dz /= d;
      } else {
        dx = fx;
        dz = fz;
      }
      const res = e.hit(amount, dx, dz, m.knock * (crit ? 1.4 : 1));
      const dealt = res ? res.dealt : amount;
      hits++;
      const hy = ep.y + (e.height || 1) * 0.6;
      this.popNumber(ep.x, ep.y + (e.height || 1) + 0.25, ep.z, String(dealt), crit ? "crit" : "");
      const hx = ep.x - dx * e.radius * 0.8;
      const hz = ep.z - dz * e.radius * 0.8;
      if (s.style === "staff") this.particles.burst(hx, hy, hz, 8, 3.5, 0.35, 0.6, 0.75, 1.0, -6);
      else this.particles.burst(hx, hy, hz, 10, 5, 0.3, 1.0, 0.75, 0.4, -9);
    }
    if (hits > 0) {
      this.hitstop = CONFIG.combat.hitstop.time;
      this.combatTimer = CONFIG.combat.combatMemory;
      this.audio.fx(s.style === "staff" ? "staffHit" : "swordHit", p);
    }
  }

  // ---- Magias -------------------------------------------------------------------------------------

  /**
   * @param {number} index 0 = Disparo Arcano, 1 = Pulso Rúnico, 2 = Luz Restauradora
   * @returns {boolean} lançou
   */
  castSpell(index) {
    const sp = this.spells[index];
    if (!sp) return false;
    this.selected = index;
    if (sp.id === "luz" && this.stats.vida >= this.stats.maxVida) {
      this.warn("Sua vida já está cheia.");
      return false;
    }
    if (!this.stats.spendMana(sp.custo)) {
      this.warn("Mana insuficiente.");
      return false;
    }
    const power = this.weaponStats().poder_magico || 1;
    this.spellCd[index] = sp.recarga;
    this.castLock = 0.3;
    if (sp.id === "arcano") this.castBolt(sp, power);
    else if (sp.id === "pulso") this.castPulse(sp, power);
    else if (sp.id === "luz") this.castHeal(sp, power);
    return true;
  }

  /**
   * @param {object} sp definição (CONFIG.combat.spells)
   * @param {number} power poder_magico da arma
   */
  castBolt(sp, power) {
    const facing = this.aimFacing(sp.alcance, sp.mira);
    this.player.faceAngle(facing);
    this.player.playAction(ANIM.magiaDisparo, 0.45, 1.4);
    this.player.slow(0.35, 0.5);
    let slot = null;
    for (let i = 0; i < this.projectiles.length; i++) {
      if (!this.projectiles[i].active) {
        slot = this.projectiles[i];
        break;
      }
    }
    if (!slot) slot = this.projectiles[0];
    const p = this.player.position;
    const dx = Math.sin(facing);
    const dz = Math.cos(facing);
    slot.active = true;
    slot.x = p.x + dx * 0.55;
    slot.y = p.y + PROJECTILE_HEIGHT;
    slot.z = p.z + dz * 0.55;
    slot.dx = dx;
    slot.dz = dz;
    slot.speed = sp.velocidade;
    slot.travelled = 0;
    slot.maxDist = sp.alcance;
    slot.dmg = Math.round(sp.dano * power);
    slot.knock = sp.knock;
    slot.radius = sp.raio;
    slot.emitAcc = 0;
    slot.sprite.position.set(slot.x, slot.y, slot.z);
    slot.sprite.visible = true;
    this.particles.burst(slot.x, slot.y, slot.z, 8, 2.5, 0.25, 0.55, 0.7, 1.0);
    this.audio.fx("arcaneCast", p);
  }

  /** @param {number} dt */
  updateProjectiles(dt) {
    const world = this.player.world;
    const list = this.enemies ? this.enemies.targets : null;
    for (let i = 0; i < this.projectiles.length; i++) {
      const b = this.projectiles[i];
      if (!b.active) continue;
      const step = b.speed * dt;
      const x1 = b.x + b.dx * step;
      const z1 = b.z + b.dz * step;
      let hitT = 2;
      let hitEnemy = null;
      if (list) {
        for (let j = 0; j < list.length; j++) {
          const e = list[j];
          if (!e.alive) continue;
          const ep = e.root.position;
          const t = segmentCircleHit(b.x, b.z, x1, z1, ep.x, ep.z, e.radius + b.radius);
          if (t >= 0 && t < hitT) {
            hitT = t;
            hitEnemy = e;
          }
        }
      }
      let wallT = 2;
      if (world && world.rayColliders) {
        const cols = world.rayColliders(b.x, b.z, x1, z1);
        for (let j = 0; j < cols.length; j++) {
          const c = cols[j];
          if (c.off || c.maxY < b.y - 0.15 || c.minY > b.y + 0.15) continue;
          const t = segmentAabbHit(b.x, b.z, x1, z1, c.minX, c.minZ, c.maxX, c.maxZ);
          if (t >= 0 && t < wallT) wallT = t;
        }
      }
      if (hitEnemy && hitT <= wallT) {
        const ix = b.x + (x1 - b.x) * hitT;
        const iz = b.z + (z1 - b.z) * hitT;
        const res = hitEnemy.hit(b.dmg, b.dx, b.dz, b.knock);
        const dealt = res ? res.dealt : b.dmg;
        const ep = hitEnemy.root.position;
        this.popNumber(ep.x, ep.y + (hitEnemy.height || 1) + 0.25, ep.z, String(dealt), "magic");
        this.impactBolt(b, ix, b.y, iz);
        this.combatTimer = CONFIG.combat.combatMemory;
        continue;
      }
      if (wallT <= 1) {
        this.impactBolt(b, b.x + (x1 - b.x) * wallT, b.y, b.z + (z1 - b.z) * wallT);
        continue;
      }
      b.x = x1;
      b.z = z1;
      b.travelled += step;
      b.sprite.position.set(b.x, b.y, b.z);
      // Rastro luminoso: ~70 partículas/s atrás da cabeça
      b.emitAcc += dt * 70;
      while (b.emitAcc >= 1) {
        b.emitAcc -= 1;
        this.particles.emit(b.x - b.dx * Math.random() * step, b.y + (Math.random() - 0.5) * 0.08, b.z - b.dz * Math.random() * step, (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.4, 0.35, 0.45, 0.6, 1.0, 0, 2);
      }
      if (b.travelled >= b.maxDist) this.impactBolt(b, b.x, b.y, b.z);
    }
  }

  /**
   * @param {object} b projétil
   * @param {number} x
   * @param {number} y
   * @param {number} z
   */
  impactBolt(b, x, y, z) {
    b.active = false;
    b.sprite.visible = false;
    this.particles.burst(x, y, z, 16, 4.5, 0.4, 0.6, 0.75, 1.0, -2);
    _proj.set(x, y, z);
    this.audio.fx("arcaneHit", _proj);
  }

  /**
   * @param {object} sp
   * @param {number} power
   */
  castPulse(sp, power) {
    this.player.playAction(ANIM.magiaPulso, 0.45, 1.2);
    this.player.slow(0.5, 0.3);
    const p = this.player.position;
    const u = this.pulse;
    u.active = true;
    u.t = 0;
    u.applied = false;
    u.x = p.x;
    u.y = p.y + 0.06;
    u.z = p.z;
    u.dmg = Math.round(sp.dano * power);
    u.radius = sp.raioArea;
    u.knock = sp.knock;
    u.dur = sp.duracao;
    u.delay = sp.atraso;
    this.ring.position.set(u.x, u.y, u.z);
    this.ring.scale.set(0.01, 0.01, 0.01);
    this.ring.visible = true;
    this.audio.fx("runePulse", p);
  }

  /** @param {number} dt */
  updatePulse(dt) {
    const u = this.pulse;
    if (!u.active) return;
    u.t += dt;
    const p = Math.min(1, u.t / u.dur);
    const r = u.radius * (1 - (1 - p) * (1 - p));
    this.ring.scale.set(Math.max(0.01, r), Math.max(0.01, r), 1);
    this.ring.material.opacity = (1 - p) * 0.9;
    if (!u.applied && u.t >= u.delay) {
      u.applied = true;
      this.applyPulse();
    }
    if (p >= 1) {
      u.active = false;
      this.ring.visible = false;
    }
  }

  applyPulse() {
    const u = this.pulse;
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      this.particles.emit(u.x + c * 0.6, u.y + 0.2, u.z + s * 0.6, c * u.radius * 1.6, 0.8, s * u.radius * 1.6, 0.45, 0.5, 0.7, 1.0, 0, 3);
    }
    const list = this.enemies ? this.enemies.targets : null;
    if (!list) return;
    let hits = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e.alive) continue;
      const ep = e.root.position;
      let dx = ep.x - u.x;
      let dz = ep.z - u.z;
      const d = Math.hypot(dx, dz);
      if (d - e.radius > u.radius) continue;
      if (d > 1e-4) {
        dx /= d;
        dz /= d;
      } else {
        dx = 0;
        dz = 1;
      }
      // Dano cai até 60% na borda do anel
      const amount = Math.max(1, Math.round(u.dmg * (1 - 0.4 * Math.min(1, d / u.radius))));
      const res = e.hit(amount, dx, dz, u.knock);
      this.popNumber(ep.x, ep.y + (e.height || 1) + 0.25, ep.z, String(res ? res.dealt : amount), "magic");
      hits++;
    }
    if (hits > 0) {
      this.combatTimer = CONFIG.combat.combatMemory;
      this.hitstop = CONFIG.combat.hitstop.time * 0.7;
    }
  }

  /**
   * @param {object} sp
   * @param {number} power
   */
  castHeal(sp, power) {
    this.player.playAction(ANIM.magiaCura, 0.5, 1.5);
    this.player.slow(0.6, 0.4);
    const amount = Math.round(sp.cura * power);
    const healed = this.stats.heal(amount);
    const p = this.player.position;
    this.popNumber(p.x, p.y + 2.1, p.z, `+${Math.round(healed)}`, "heal");
    const h = this.heal;
    h.active = true;
    h.t = 0;
    h.dur = sp.duracao;
    h.emit = 0;
    this.healGlow.visible = true;
    this.audio.fx("healCast", p);
  }

  /** @param {number} dt */
  updateHeal(dt) {
    const h = this.heal;
    if (!h.active) return;
    h.t += dt;
    const p = this.player.position;
    const f = h.t / h.dur;
    if (f >= 1) {
      h.active = false;
      this.healGlow.visible = false;
      return;
    }
    this.healGlow.position.set(p.x, p.y + 1.0, p.z);
    const pulse = Math.sin(f * Math.PI);
    this.healGlow.material.opacity = 0.55 * pulse;
    this.healGlow.scale.setScalar(1.6 + pulse * 1.2);
    h.emit += dt * 55 * (1 - f);
    while (h.emit >= 1) {
      h.emit -= 1;
      const a = Math.random() * Math.PI * 2;
      const r = 0.25 + Math.random() * 0.45;
      this.particles.emit(p.x + Math.cos(a) * r, p.y + 0.1 + Math.random() * 0.4, p.z + Math.sin(a) * r, 0, 1.4 + Math.random() * 0.8, 0, 0.9, 0.6, 1.0, 0.55, 0.6, 0.5);
    }
  }

  // ---- Esquiva ------------------------------------------------------------------------------------

  startDodge() {
    const d = CONFIG.combat.dodge;
    if (!this.stats.spendVigor(d.cost)) {
      this.warn("Sem fôlego para esquivar.");
      return;
    }
    const pl = this.player;
    const k = pl.keys;
    const f = (k.KeyW || k.ArrowUp ? 1 : 0) - (k.KeyS || k.ArrowDown ? 1 : 0);
    const s = (k.KeyD || k.ArrowRight ? 1 : 0) - (k.KeyA || k.ArrowLeft ? 1 : 0);
    const sy = Math.sin(pl.yaw);
    const cy = Math.cos(pl.yaw);
    // frente da câmera = (-sin yaw, -cos yaw); direita = (cos yaw, -sin yaw); parado = para trás
    let dx = -sy * f + cy * s;
    let dz = -cy * f - sy * s;
    if (dx * dx + dz * dz < 1e-6) {
      dx = sy;
      dz = cy;
    }
    pl.dash(dx, dz, d.speed, d.time);
    this.invuln = Math.max(this.invuln, d.iframes);
    this.dodgeCd = d.cooldown;
    // Golpe ainda antes do impacto é cancelado pela esquiva
    if (this.swing.active && !this.swing.hitDone) {
      this.swing.active = false;
      this.trail.stop();
    }
    const clip = dodgeClip(dx, dz, pl.facing);
    const dur = pl.character ? pl.character.duration(clip) : 0.4;
    pl.playAction(clip, d.time + 0.05, Math.max(0.8, dur / (d.time + 0.1)), 0.05);
    const p = pl.position;
    for (let i = 0; i < 8; i++) this.particles.emit(p.x + (Math.random() - 0.5) * 0.4, p.y + 0.08, p.z + (Math.random() - 0.5) * 0.4, -dx * 1.5 + (Math.random() - 0.5), 0.5 + Math.random() * 0.5, -dz * 1.5 + (Math.random() - 0.5), 0.45, 0.32, 0.28, 0.24, -1.5, 2);
    this.audio.fx("dodge", p);
  }

  // ---- Dano recebido / desmaio --------------------------------------------------------------------

  /**
   * Golpe de inimigo no jogador (via playerTarget.hurt).
   * @param {number} amount
   * @param {number} fromX origem do golpe
   * @param {number} fromZ
   */
  hurt(amount, fromX, fromZ) {
    if (this.dead || this.invuln > 0 || amount <= 0) return;
    const h = CONFIG.combat.hurt;
    const dealt = this.stats.damage(amount);
    this.invuln = h.iframes;
    this.combatTimer = CONFIG.combat.combatMemory;
    const p = this.player.position;
    const dx = p.x - fromX;
    const dz = p.z - fromZ;
    this.player.push(dx, dz, h.knock);
    this.hud.flashHurt();
    this.popNumber(p.x, p.y + 2.0, p.z, `-${Math.round(dealt)}`, "hurt");
    this.audio.fx("playerHurt", p);
    if (this.stats.dead) {
      this.die();
      return;
    }
    if (!this.swing.active && !this.player.dashing) this.player.playAction(ANIM.ferido, 0.3, 1.4, 0.06);
  }

  die() {
    if (this.dead) return;
    this.dead = true;
    this.deathNotified = false;
    this.deathTimer = CONFIG.combat.hurt.faintDelay;
    this.intent = INTENT_NONE;
    this.swing.active = false;
    this.trail.stop();
    this.player.setDead(true);
    this.player.releasePointer();
    this.hud.setFainted(true);
  }

  // ---- Números flutuantes -------------------------------------------------------------------------

  /**
   * @param {number} x mundo
   * @param {number} y
   * @param {number} z
   * @param {string} text
   * @param {string} kind classe CSS (hud.acquireNumber)
   */
  popNumber(x, y, z, text, kind) {
    let rec = null;
    for (let i = 0; i < this.numbers.length; i++) {
      if (!this.numbers[i].active) {
        rec = this.numbers[i];
        break;
      }
    }
    if (!rec) {
      // Todos em uso: recicla o mais velho
      rec = this.numbers[0];
      for (let i = 1; i < this.numbers.length; i++) if (this.numbers[i].t > rec.t) rec = this.numbers[i];
      this.hud.releaseNumber(rec.slot);
    }
    rec.active = true;
    rec.x = x;
    rec.y = y;
    rec.z = z;
    rec.t = 0;
    rec.drift = (Math.random() - 0.5) * 30;
    rec.slot = this.hud.acquireNumber(text, kind);
  }

  /** @param {number} dt */
  updateNumbers(dt) {
    const cfg = CONFIG.combat.numbers;
    const cam = this.camera;
    for (let i = 0; i < this.numbers.length; i++) {
      const n = this.numbers[i];
      if (!n.active) continue;
      n.t += dt;
      if (n.t >= cfg.life) {
        n.active = false;
        this.hud.releaseNumber(n.slot);
        continue;
      }
      const f = n.t / cfg.life;
      _proj.set(n.x, n.y + cfg.rise * (1 - (1 - f) * (1 - f)), n.z).project(cam);
      if (_proj.z > 1 || _proj.z < -1) {
        this.hud.placeNumber(n.slot, -100, -100, 0, 1);
        continue;
      }
      const sx = (_proj.x * 0.5 + 0.5) * this.width + n.drift * f;
      const sy = (-_proj.y * 0.5 + 0.5) * this.height;
      const pop = n.t < 0.12 ? 1 + (1 - n.t / 0.12) * 0.45 : 1;
      const alpha = f < 0.7 ? 1 : 1 - (f - 0.7) / 0.3;
      this.hud.placeNumber(n.slot, sx, sy, alpha, pop);
    }
  }
}
