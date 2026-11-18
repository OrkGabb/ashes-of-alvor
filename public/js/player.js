import * as THREE from "three";
import { ANIM, CONFIG, dampAngle, dampFactor } from "./config.js";

// Jogador: o "Desperto" (corpo KayKit recolorido com roupa de outro mundo), entrada WASD/mouse,
// colisão círculo x AABB contra os colisores do city.json, piso pela zona, fôlego para correr,
// frio que deixa o passo mais lento e câmera 1ª/3ª pessoa com enquadramento no diálogo.

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _move = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _look = new THREE.Vector3();
const _pivot = new THREE.Vector3();
const CAM_WALL_PAD = 0.28;   // folga entre a câmera e a parede (o plano near não atravessa a superfície)
const CAM_MIN_DIST = 0.45;   // mais perto que isso do pescoço, a câmera fica onde está (jogador colado na parede)

// Fração [0, 1] do segmento pivô -> alvo até o primeiro colisor (colunas XZ, infinitas em Y, infladas pela folga).
// Portas e portões ficam de fora: abrem e fecham, e a folha é fina demais para esconder a câmera.
function cameraHit(colliders, px, pz, tx, tz) {
  const dx = tx - px;
  const dz = tz - pz;
  const reach = Math.hypot(dx, dz) + CAM_WALL_PAD + 0.5;
  let best = 1;
  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    if (c.door || c.gate) continue;
    const x0 = c.minX - CAM_WALL_PAD;
    const x1 = c.maxX + CAM_WALL_PAD;
    const z0 = c.minZ - CAM_WALL_PAD;
    const z1 = c.maxZ + CAM_WALL_PAD;
    if (px < x0 - reach || px > x1 + reach || pz < z0 - reach || pz > z1 + reach) continue;
    if (px > x0 && px < x1 && pz > z0 && pz < z1) continue; // o pivô já está dentro (encostado): ignora
    let tmin = 0;
    let tmax = best;
    if (Math.abs(dx) < 1e-6) {
      if (px < x0 || px > x1) continue;
    } else {
      let ta = (x0 - px) / dx;
      let tb = (x1 - px) / dx;
      if (ta > tb) [ta, tb] = [tb, ta];
      tmin = Math.max(tmin, ta);
      tmax = Math.min(tmax, tb);
      if (tmin > tmax) continue;
    }
    if (Math.abs(dz) < 1e-6) {
      if (pz < z0 || pz > z1) continue;
    } else {
      let ta = (z0 - pz) / dz;
      let tb = (z1 - pz) / dz;
      if (ta > tb) [ta, tb] = [tb, ta];
      tmin = Math.max(tmin, ta);
      tmax = Math.min(tmax, tb);
      if (tmin > tmax) continue;
    }
    if (tmin < best) best = tmin;
  }
  return best;
}
const MOVE_SUBSTEP = 0.25;   // m: deslocamento máximo entre duas resoluções de colisão (esquiva não atravessa parede)
const WEAPON_SLOT = "handslot.r";

/**
 * Aproximação exponencial de uma velocidade escalar: acelera com 'accel' quando o alvo é maior em
 * módulo e freia com 'decel' quando é menor. Independente da taxa de quadros (dampFactor).
 * Mesma regra que Player.update aplica ao vetor velocidade.
 * @param {number} current
 * @param {number} target
 * @param {number} accel 1/s
 * @param {number} decel 1/s
 * @param {number} dt s
 * @returns {number}
 */
export function approachSpeed(current, target, accel, decel, dt) {
  const rate = Math.abs(target) >= Math.abs(current) ? accel : decel;
  return current + (target - current) * dampFactor(rate, dt);
}

/**
 * Animação de corrida com histerese: entra acima de 'enter' e só sai abaixo de 'exit'
 * (frações da faixa andar..correr), para a troca run/walk não piscar perto do limiar.
 * @param {boolean} wasRunning
 * @param {number} speed m/s atual
 * @param {number} walk m/s de andar (já com o fator de frio)
 * @param {number} run m/s de correr (já com o fator de frio)
 * @param {number} enter
 * @param {number} exit
 * @returns {boolean}
 */
export function runAnimState(wasRunning, speed, walk, run, enter, exit) {
  const f = (speed - walk) / Math.max(1e-6, run - walk);
  return wasRunning ? f > exit : f > enter;
}

const SEAT_DOWN = 1;
const SEAT_LOOP = 2;
const SEAT_UP = 3;

export class Player {
  constructor(scene, camera, domElement) {
    this.scene = scene;
    this.camera = camera;
    this.dom = domElement;
    this.group = new THREE.Group();
    this.group.name = "Player";
    scene.add(this.group);
    this.character = null;
    this.yaw = 0;
    this.pitch = -0.08;
    this.thirdPerson = true;
    this.keys = Object.create(null);
    this.pointerLocked = false;
    this.dragging = false;
    this.inputBlocked = false;
    this.currentLook = new THREE.Vector3(0, 1.5, -10);
    this.floorY = 0;
    this.moving = false;
    this.running = false;
    this.actionLock = 0;
    this.stats = null;
    this.seat = null;
    // Locomoção suavizada (m/s, mundo XZ) e estado da animação/câmera
    this.velX = 0;
    this.velZ = 0;
    this.speed = 0;
    this.coldFactor = 1;
    this.runAnim = false;
    this.fov = CONFIG.camera.fov;
    this.wantsRun = false;
    this.canSprint = false;
    // Combate: esquiva, empurrão, travas de animação e lentidão durante o golpe
    this.dashT = 0;
    this.dashDur = 0;
    this.dashX = 0;
    this.dashZ = 0;
    this.dashSpeed = 0;
    this.knockX = 0;
    this.knockZ = 0;
    this.animLock = 0;
    this.slowTimer = 0;
    this.slowFactor = 1;
    this.dead = false;
    // Arma na mão (game.equipado.arma -> items[id].modelo)
    this.factory = null;
    this.game = null;
    this.weaponWanted = null;
    this.weaponId = null;
    this.weaponObject = null;
    this.bindInput();
  }

  get position() {
    return this.group.position;
  }

  async build(factory) {
    this.factory = factory;
    const p = CONFIG.player;
    this.character = await factory.create({ model: p.model, scale: p.scale, recolor: p.recolor, hide: p.hide });
    this.group.add(this.character.root);
    this.character.play(ANIM.idle, { fade: 0 });
    if (this.game) this.refreshWeapon();
  }

  spawn(spawn) {
    this.group.position.set(spawn.x, 0, spawn.z);
    this.yaw = spawn.yaw || 0;
    this.group.rotation.y = this.yaw + Math.PI;
  }

  // Animação curta de ação (pegar item, usar consumível) que trava o movimento por um instante
  gesture(name) {
    if (!this.character) return;
    this.character.play(name, { once: true, fade: 0.12 });
    this.actionLock = Math.min(1.1, this.character.duration(name) * 0.85);
  }

  // Sentado (ou descendo para sentar): o SeatSystem consulta para ocupação e regeneração
  get seated() {
    return this.seat !== null && this.seat.phase !== SEAT_UP;
  }

  // Encaixa no assento, encara o ponto 'look', desce e fica no loop; WASD ou E levanta
  sitAt(x, z, lookX, lookZ) {
    if (!this.character) return false;
    const pos = this.group.position;
    pos.set(x, pos.y, z);
    const face = Math.atan2(lookX - x, lookZ - z);
    this.group.rotation.y = face;
    this.yaw = face + Math.PI;
    let dx = lookX - x;
    let dz = lookZ - z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    const off = CONFIG.props.seat.standOffset;
    const wasFirst = !this.thirdPerson;
    if (wasFirst) this.toggleView();
    this.seat = { phase: SEAT_DOWN, t: 0, x, z, standX: x + dx * off, standZ: z + dz * off, wasFirst, dur: this.character.duration(ANIM.sentarDescer) * 0.92 };
    this.character.play(ANIM.sentarDescer, { once: true, fade: 0.2 });
    return true;
  }

  standUp() {
    const st = this.seat;
    if (!st || st.phase === SEAT_UP) return;
    st.phase = SEAT_UP;
    st.t = 0;
    st.dur = Math.max(0.3, this.character.duration(ANIM.sentarLevantar) * 0.85);
    this.character.play(ANIM.sentarLevantar, { once: true, fade: 0.15 });
  }

  updateSeat(dt) {
    const st = this.seat;
    st.t += dt;
    const k = this.keys;
    if (st.phase === SEAT_DOWN && st.t >= st.dur) {
      st.phase = SEAT_LOOP;
      this.character.play(ANIM.sentar, { fade: 0.15 });
    } else if (st.phase === SEAT_LOOP && !this.inputBlocked && (k.KeyW || k.KeyA || k.KeyS || k.KeyD || k.ArrowUp || k.ArrowDown || k.ArrowLeft || k.ArrowRight)) {
      this.standUp();
    } else if (st.phase === SEAT_UP) {
      // Durante o levantar o corpo desliza para fora do banco (o colisor dele volta a valer depois)
      const f = Math.min(1, st.t / st.dur);
      const e = f * f * (3 - 2 * f);
      const pos = this.group.position;
      pos.x = st.x + (st.standX - st.x) * e;
      pos.z = st.z + (st.standZ - st.z) * e;
      if (f >= 1) {
        if (st.wasFirst && this.thirdPerson) this.toggleView();
        this.seat = null;
        this.character.play(ANIM.idle, { fade: 0.25 });
      }
    }
  }

  bindInput() {
    window.addEventListener("keydown", (e) => {
      this.keys[e.code] = true;
    });
    window.addEventListener("keyup", (e) => {
      this.keys[e.code] = false;
    });
    window.addEventListener("blur", () => {
      for (const k in this.keys) this.keys[k] = false;
    });
    this.dom.addEventListener("mousedown", () => {
      if (this.inputBlocked) return;
      this.dragging = true;
      if (!this.pointerLocked && this.dom.requestPointerLock) {
        try {
          const pending = this.dom.requestPointerLock();
          if (pending && typeof pending.catch === "function") pending.catch(() => {});
        } catch (_) {
          this.pointerLocked = false;
        }
      }
    });
    window.addEventListener("mouseup", () => {
      this.dragging = false;
    });
    document.addEventListener("pointerlockchange", () => {
      this.pointerLocked = document.pointerLockElement === this.dom;
    });
    window.addEventListener("mousemove", (e) => {
      if (this.inputBlocked || (!this.pointerLocked && !this.dragging)) return;
      const s = CONFIG.player.mouseSensitivity;
      this.yaw -= e.movementX * s;
      this.pitch = Math.max(-0.65, Math.min(0.55, this.pitch - e.movementY * s));
    });
  }

  toggleView() {
    this.thirdPerson = !this.thirdPerson;
    this.group.visible = this.thirdPerson;
  }

  releasePointer() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  resolveCollisions(pos, world) {
    const r = CONFIG.player.radius;
    const list = world.collidersNear ? world.collidersNear(pos.x, pos.z, 4.0) : world.colliders;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      // off: porta aberta / portão erguido (flag escrita pelo props.js, sem busca por string)
      if (b.off || b.minY > 1.4 || b.maxY < 0.25) continue;
      if (pos.x < b.minX - r || pos.x > b.maxX + r || pos.z < b.minZ - r || pos.z > b.maxZ + r) continue;
      const cx = Math.max(b.minX, Math.min(pos.x, b.maxX));
      const cz = Math.max(b.minZ, Math.min(pos.z, b.maxZ));
      const dx = pos.x - cx;
      const dz = pos.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
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
    pos.x = Math.max(wb.minX, Math.min(wb.maxX, pos.x));
    pos.z = Math.max(wb.minZ, Math.min(wb.maxZ, pos.z));
  }

  resolveAgents(agents) {
    const pos = this.group.position;
    const r = CONFIG.player.radius;
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (!a.root.visible) continue;
      const np = a.root.position;
      const dx = pos.x - np.x;
      const dz = pos.z - np.z;
      const min = r + a.radius;
      const d2 = dx * dx + dz * dz;
      if (d2 < min * min && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        pos.x = np.x + (dx / d) * min;
        pos.z = np.z + (dz / d) * min;
      }
    }
  }

  /**
   * Desloca com colisão em subpassos (no máximo MOVE_SUBSTEP por resolução).
   * @param {number} dx
   * @param {number} dz
   * @param {object} world WorldIndex
   * @param {Array<object>} agents NPCs
   */
  moveWithCollisions(dx, dz, world, agents) {
    const pos = this.group.position;
    const len = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(len / MOVE_SUBSTEP));
    const sx = dx / steps;
    const sz = dz / steps;
    for (let i = 0; i < steps; i++) {
      pos.x += sx;
      pos.z += sz;
      this.resolveCollisions(pos, world);
    }
    this.resolveAgents(agents);
    this.resolveCollisions(pos, world);
  }

  /**
   * @param {number} dt
   * @param {object} world WorldIndex
   * @param {object} zone zona atual (floorY)
   * @param {Array<object>} agents NPCs (colisão de corpo)
   */
  update(dt, world, zone, agents) {
    this.world = world;
    const cfg = CONFIG.player;
    const pos = this.group.position;
    this.floorY += ((zone.floorY || 0) - this.floorY) * dampFactor(14, dt);
    pos.y = this.floorY;
    this.actionLock = Math.max(0, this.actionLock - dt);
    this.animLock = Math.max(0, this.animLock - dt);
    this.slowTimer = Math.max(0, this.slowTimer - dt);
    const k = this.keys;
    const free = !this.inputBlocked && !this.dead && !this.seat;
    const wantsRun = free && Boolean(k.ShiftLeft || k.ShiftRight);
    this.wantsRun = wantsRun;
    // Exatamente UMA consulta por quadro, parado ou não: a histerese de exaustão do PlayerStats
    // precisa ver o Shift solto/apertado para liberar o sprint de novo
    this.canSprint = this.stats ? this.stats.canRun(wantsRun) : wantsRun;
    this.coldFactor = this.stats ? this.stats.speedFactor() : 1;
    let moving = false;
    let running = false;
    if (this.seat) {
      this.updateSeat(dt);
      this.velX = 0;
      this.velZ = 0;
      this.speed = 0;
      this.moving = false;
      this.running = false;
      if (this.character) this.character.update(dt);
      return;
    }
    let tx = 0;
    let tz = 0;
    if (free && this.actionLock <= 0) {
      const f = (k.KeyW || k.ArrowUp ? 1 : 0) - (k.KeyS || k.ArrowDown ? 1 : 0);
      const s = (k.KeyD || k.ArrowRight ? 1 : 0) - (k.KeyA || k.ArrowLeft ? 1 : 0);
      _forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      _move.set(0, 0, 0).addScaledVector(_forward, f).addScaledVector(_right, s);
      if (_move.lengthSq() > 1e-3) {
        moving = true;
        running = wantsRun && this.canSprint;
        _move.normalize();
        let target = (running ? cfg.runSpeed : cfg.walkSpeed) * this.coldFactor;
        if (this.slowTimer > 0) target *= this.slowFactor;
        tx = _move.x * target;
        tz = _move.z * target;
        if (this.dashT <= 0 && this.animLock <= 0) this.group.rotation.y = dampAngle(this.group.rotation.y, Math.atan2(_move.x, _move.z), 14, dt);
      }
    }
    if (this.dashT > 0) {
      // Esquiva: velocidade decai ao longo do dash; no fim a suavização normal assume sem degrau
      const e = this.dashT / this.dashDur;
      const v = this.dashSpeed * (0.45 + 0.55 * e);
      this.velX = this.dashX * v;
      this.velZ = this.dashZ * v;
      this.dashT = Math.max(0, this.dashT - dt);
    } else {
      // Aceleração/frenagem exponencial no vetor velocidade (sem degrau andar <-> correr <-> parar)
      const kf = dampFactor(tx * tx + tz * tz >= this.velX * this.velX + this.velZ * this.velZ ? cfg.accel : cfg.decel, dt);
      this.velX += (tx - this.velX) * kf;
      this.velZ += (tz - this.velZ) * kf;
    }
    this.speed = Math.hypot(this.velX, this.velZ);
    const kd = dampFactor(cfg.knockDecay, dt);
    this.knockX -= this.knockX * kd;
    this.knockZ -= this.knockZ * kd;
    const dx = (this.velX + this.knockX) * dt;
    const dz = (this.velZ + this.knockZ) * dt;
    if (dx * dx + dz * dz > 1e-10) this.moveWithCollisions(dx, dz, world, agents);
    this.moving = moving;
    this.running = running;
    if (this.character) {
      if (!this.dead && this.actionLock <= 0 && this.animLock <= 0 && this.dashT <= 0) this.updateLocomotionAnim(moving);
      this.character.update(dt);
    }
  }

  /**
   * Escolhe parado/andar/correr pela velocidade suavizada, com histerese, e ajusta o ritmo dos passos.
   * @param {boolean} moving há tecla de movimento
   */
  updateLocomotionAnim(moving) {
    const cfg = CONFIG.player;
    const ch = this.character;
    const walk = cfg.walkSpeed * this.coldFactor;
    const run = cfg.runSpeed * this.coldFactor;
    if (moving || this.speed > cfg.idleSpeed) {
      this.runAnim = runAnimState(this.runAnim, this.speed, walk, run, cfg.runAnimEnter, cfg.runAnimExit);
      ch.play(this.runAnim ? ANIM.run : ANIM.walk, { fade: 0.3 });
      const rate = this.runAnim ? this.speed / run : this.speed / walk;
      ch.setPlaybackRate(Math.max(this.runAnim ? 0.8 : 0.55, Math.min(1.2, rate)));
    } else {
      this.runAnim = false;
      ch.play(ANIM.idle, { fade: 0.3 });
    }
  }

  // ---- API de combate (combat.js) ----------------------------------------------------------------

  /** @returns {number} ângulo Y do corpo (frente do modelo = (sin, cos)) */
  get facing() {
    return this.group.rotation.y;
  }

  /** @param {number} angle vira o corpo na hora (golpe na direção da mira) */
  faceAngle(angle) {
    this.group.rotation.y = angle;
  }

  /**
   * Esquiva: dash na direção dada (normalizada aqui), com colisão em subpassos.
   * @param {number} dirX
   * @param {number} dirZ
   * @param {number} speed m/s no início
   * @param {number} time s
   */
  dash(dirX, dirZ, speed, time) {
    const len = Math.hypot(dirX, dirZ) || 1;
    this.dashX = dirX / len;
    this.dashZ = dirZ / len;
    this.dashSpeed = speed;
    this.dashT = time;
    this.dashDur = time;
  }

  /** @returns {boolean} esquiva em andamento */
  get dashing() {
    return this.dashT > 0;
  }

  /**
   * Empurrão (golpe recebido). Soma ao que já houver e decai com CONFIG.player.knockDecay.
   * @param {number} dirX
   * @param {number} dirZ
   * @param {number} impulse m/s
   */
  push(dirX, dirZ, impulse) {
    const len = Math.hypot(dirX, dirZ);
    if (len < 1e-6) return;
    this.knockX += (dirX / len) * impulse;
    this.knockZ += (dirZ / len) * impulse;
  }

  /**
   * Lentidão temporária (andar golpeando).
   * @param {number} time s
   * @param {number} factor fração da velocidade
   */
  slow(time, factor) {
    this.slowTimer = Math.max(this.slowTimer, time);
    this.slowFactor = factor;
  }

  /**
   * Toca uma animação de ação uma vez sem travar o movimento; a locomoção não a sobrescreve por 'lock' s.
   * @param {string} name clipe KayKit
   * @param {number} lock s
   * @param {number} [timeScale=1]
   * @param {number} [fade=0.08]
   * @returns {number} duração efetiva do clipe (0 se não existe)
   */
  playAction(name, lock, timeScale = 1, fade = 0.08) {
    const ch = this.character;
    if (!ch || !ch.hasClip(name)) return 0;
    ch.play(name, { once: true, fade, timeScale });
    this.animLock = Math.max(this.animLock, lock);
    this.runAnim = false;
    return ch.duration(name) / timeScale;
  }

  /**
   * Desmaio: trava entrada e movimento e toca a queda (para no último quadro). false volta ao normal.
   * @param {boolean} flag
   * @param {string} [clip] animação de queda
   */
  setDead(flag, clip = ANIM.morte) {
    this.dead = flag;
    this.velX = 0;
    this.velZ = 0;
    this.speed = 0;
    this.dashT = 0;
    this.knockX = 0;
    this.knockZ = 0;
    this.animLock = 0;
    this.actionLock = 0;
    if (!this.character) return;
    if (flag) this.character.play(clip, { once: true, fade: 0.15 });
    else this.character.play(ANIM.idle, { fade: 0.3 });
  }

  /**
   * Passa a mostrar a arma equipada e a trocá-la quando o GameState mudar.
   * @param {EventTarget & {equipado?: {arma?: string}, items: Record<string, object>}} game
   */
  bindEquipment(game) {
    if (this.game === game) return;
    this.game = game;
    game.addEventListener("change", () => this.refreshWeapon());
    this.refreshWeapon();
  }

  /** Confere game.equipado.arma e carrega o modelo se mudou. */
  refreshWeapon() {
    // Sem corpo ainda: build() chama de novo ao terminar
    if (!this.character) return;
    const g = this.game;
    const id = (g && g.equipado && g.equipado.arma) || null;
    if (id === this.weaponWanted) return;
    this.weaponWanted = id;
    this.loadWeapon(id);
  }

  /**
   * @param {string | null} id item equipado
   * @returns {Promise<void>}
   */
  async loadWeapon(id) {
    if (!this.character) return;
    const def = id && this.game ? this.game.items[id] : null;
    const url = def && def.modelo;
    if (!url || !this.factory) {
      this.character.detach(WEAPON_SLOT);
      this.weaponObject = null;
      this.weaponId = id;
      if (id && !url) console.warn(`[Alvor] Arma ${id} sem campo "modelo": segue sem modelo na mão.`);
      return;
    }
    try {
      const obj = await this.factory.loadProp(url);
      if (this.weaponWanted !== id) return; // trocou de arma enquanto carregava
      obj.name = `weapon:${id}`;
      if (!this.character.attach(obj, WEAPON_SLOT)) console.warn("[Alvor] Esqueleto sem encaixe de mão (handslot.r).");
      this.weaponObject = obj;
      this.weaponId = id;
    } catch (err) {
      if (this.weaponWanted !== id) return;
      this.character.detach(WEAPON_SLOT);
      this.weaponObject = null;
      this.weaponId = id;
      console.warn(`[Alvor] Modelo da arma indisponível (${url}); segue sem modelo na mão.`, err);
    }
  }

  // Aproxima 'p' do pivô até antes do primeiro colisor no caminho (só em XZ; a altura acompanha a fração)
  pullCamera(p) {
    const len = Math.hypot(p.x - _pivot.x, p.z - _pivot.z);
    if (len <= CAM_MIN_DIST) return;
    const cols = this.world.rayColliders ? this.world.rayColliders(_pivot.x, _pivot.z, p.x, p.z) : this.world.colliders;
    const t = cameraHit(cols, _pivot.x, _pivot.z, p.x, p.z);
    if (t >= 1) return;
    const keep = Math.max(CAM_MIN_DIST / len, t);
    p.x = _pivot.x + (p.x - _pivot.x) * keep;
    p.z = _pivot.z + (p.z - _pivot.z) * keep;
    p.y = _pivot.y + (p.y - _pivot.y) * keep;
  }

  faceTowards(target, dt) {
    const p = this.group.position;
    this.group.rotation.y = dampAngle(this.group.rotation.y, Math.atan2(target.x - p.x, target.z - p.z), 6, dt);
  }

  updateCamera(dt, zone, dialogueTarget, fallbackLook) {
    const cam = this.camera;
    // Campo de visão: abre um pouco com a velocidade acima do andar (correr, esquiva), suavizado
    let fovTarget = CONFIG.camera.fov;
    if (!dialogueTarget && !fallbackLook) {
      const p = CONFIG.player;
      const walk = p.walkSpeed * this.coldFactor;
      const run = p.runSpeed * this.coldFactor;
      fovTarget += p.runFovBoost * Math.max(0, Math.min(1, (this.speed - walk) / Math.max(1e-6, run - walk)));
    }
    this.fov += (fovTarget - this.fov) * dampFactor(CONFIG.player.fovRate, dt);
    if (Math.abs(cam.fov - this.fov) > 1e-3) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
    const pos = this.group.position;
    const margin = CONFIG.camera.clampMargin;
    if (dialogueTarget) {
      // Plano por cima do ombro, enquadrando o rosto do interlocutor
      const np = dialogueTarget.position;
      let dx = pos.x - np.x;
      let dz = pos.z - np.z;
      let len = Math.hypot(dx, dz);
      if (len < 0.01) {
        dx = 0;
        dz = 1;
        len = 1;
      }
      dx /= len;
      dz /= len;
      const back = Math.min(3.0, Math.max(1.2, len)) + 0.9;
      _camPos.set(np.x + dx * back - dz * 0.75, dialogueTarget.headY + 0.25, np.z + dz * back + dx * 0.75);
      _look.set(np.x, dialogueTarget.headY - back * CONFIG.camera.dialogueFrameDrop, np.z);
    } else if (fallbackLook) {
      _camPos.copy(fallbackLook.cameraPos);
      _look.copy(fallbackLook.look);
    } else if (this.thirdPerson) {
      const d = CONFIG.camera.thirdDistance;
      const cp = Math.cos(this.pitch);
      _camPos.set(
        pos.x + Math.sin(this.yaw) * d * cp,
        pos.y + Math.max(0.6, CONFIG.camera.thirdHeight - Math.sin(this.pitch) * 1.8),
        pos.z + Math.cos(this.yaw) * d * cp
      );
      _look.set(pos.x - Math.sin(this.yaw) * 4, pos.y + 1.35 + Math.sin(this.pitch) * 3, pos.z - Math.cos(this.yaw) * 4);
    } else {
      _camPos.set(pos.x, pos.y + CONFIG.player.eyeHeight, pos.z);
      _look.set(pos.x - Math.sin(this.yaw) * 6, pos.y + CONFIG.player.eyeHeight + Math.sin(this.pitch) * 5, pos.z - Math.cos(this.yaw) * 6);
    }
    if (zone.cameraClamp) {
      _camPos.x = Math.max(zone.minX + margin, Math.min(zone.maxX - margin, _camPos.x));
      _camPos.z = Math.max(zone.minZ + margin, Math.min(zone.maxZ - margin, _camPos.z));
      _camPos.y = Math.min(_camPos.y, 2.55);
    }
    const camRate = dialogueTarget || fallbackLook ? 5.5 : this.thirdPerson ? 12 : 18;
    // Colisão da câmera: sem ela, ao girar perto de uma casa a câmera entrava na parede e a tela piscava escura.
    // O alvo é puxado para antes do primeiro colisor e a posição suavizada é conferida de novo (a suavização
    // podia atravessar a parede no meio do caminho).
    const blockCam = this.world && !fallbackLook && (this.thirdPerson || dialogueTarget);
    if (blockCam) {
      _pivot.set(pos.x, pos.y + 1.35, pos.z);
      this.pullCamera(_camPos);
    }
    cam.position.lerp(_camPos, dampFactor(camRate, dt));
    if (blockCam) this.pullCamera(cam.position);
    // Câmera colada no personagem (encostado numa parede): esconde o corpo em vez de mostrar o interior da cabeça
    if (this.character && this.thirdPerson) {
      this.character.root.visible = Math.hypot(cam.position.x - pos.x, cam.position.z - pos.z) > 0.8 || cam.position.y > pos.y + 2.2;
    }
    this.currentLook.lerp(_look, dampFactor(camRate + 2, dt));
    cam.lookAt(this.currentLook);
  }
}
