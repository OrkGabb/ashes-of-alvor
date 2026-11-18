import * as THREE from "three";
import { QuadrupedRig, fitToHeight, loadModel, maxDimension, pushOutOfRect, resolveCircle, turnTowards } from "./fauna.js";

// Monstros de Cinzas de Alvor (contrato EnemySystem — ver CONTRATO de integração).
// Tipos e atributos: public/data/enemies.json (fonte única). Pontos de nascimento e patrulhas: city.json -> enemySpawns
// (gerado por tools/zones/*.py e validado em test_city.py: alcançáveis, hostis fora da muralha).
// Máquina de estados: PATROL -> ALERT -> CHASE -> TELEGRAPH (aviso no chão + enemyTelegraph) -> ATTACK -> (HURT) ->
// RETURN (desistiu: além de 'desiste' do jogador ou do 'leash' do ponto) ou DEAD -> renasce após 'respawn' s.
// Visual por modelo.tipo: "glb" (animais Kenney animados por código), "personagem" (KayKit + arma na mão) e
// "procedural" (slime gelatinoso, golem rúnico, boneco de treino). Barras de vida num pool fixo de DOM.
// Desempenho: IA só perto do jogador, animação só perto da câmera, nenhuma alocação ou closure por frame.

export const ENEMY_STATE = Object.freeze({ PATROL: 0, ALERT: 1, CHASE: 2, TELEGRAPH: 3, ATTACK: 4, HURT: 5, RETURN: 6, DEAD: 7 });
const S = ENEMY_STATE;

/** Voz de cada tipo (nomes de FX_SYNTHS do audio.js); a forma do modelo é o reserva para tipos novos. */
const VOICE_BY_TYPE = Object.freeze({ javali: "boarGrunt", lobo: "wolfGrowl", slime: "slimeSquish", esqueleto: "boneRattle", guardiao: "golemRumble" });
const VOICE_BY_SHAPE = Object.freeze({ slime: "slimeSquish", golem_runico: "golemRumble", personagem: "boneRattle", glb: "boarGrunt" });
/** Peças de arma/escudo embutidas no corpo KayKit: somem quando o inimigo empunha a arma própria (modelo.arma). */
const KAYKIT_GEAR = Object.freeze(["1H_Sword", "1H_Sword_Offhand", "Badge_Shield", "Rectangle_Shield", "Round_Shield", "Spike_Shield", "2H_Sword"]);

const AI_DIST = 60;          // IA completa até essa distância do jogador (m)
const ANIM_DIST = 50;        // animação até essa distância da câmera
const VIEW_DIST = 95;        // visível até essa distância da câmera
const BAR_POOL = 8;
const BAR_DIST = 28;
const ELITE_BAR_DIST = 30;
const ALERT_TIME = 0.45;
const ATTACK_TIME = 0.34;    // golpe depois do telégrafo
const STRIKE_AT = 0.12;      // instante do impacto dentro do golpe
const STRIKE_GRACE = 0.35;   // folga de alcance no impacto (o jogador precisa sair de verdade para escapar)
const STRIKE_COS = Math.cos((75 * Math.PI) / 180);
const DEATH_FADE = 2.4;
const DUMMY_REGEN_DELAY = 2.0;
const RESPAWN_CLEAR = 14;    // não renasce com o jogador a menos disso do ponto
const PLAYER_RADIUS = 0.32;

const PLAY_LOOP = Object.freeze({ fade: 0.2 });
const PLAY_HIT = Object.freeze({ fade: 0.08, once: true });
const PLAY_DEATH = Object.freeze({ fade: 0.12, once: true });
const _attackOpts = { fade: 0.1, once: true, timeScale: 1 };   // reaproveitado: timeScale muda por golpe

const _proj = new THREE.Vector3();
const _soundPos = new THREE.Vector3();

/**
 * @typedef {{position: THREE.Vector3, radius: number, readonly invulnerable: boolean, readonly dead: boolean, hurt: (amount: number, fromX: number, fromZ: number) => void}} PlayerTarget
 * @typedef {{id: string, tipo: string, x: number, z: number, yaw: number, patrulha: number[][], leash: number}} EnemySpawn
 */

// ------------------------------------------------------------------------------------------------
// Geometrias compartilhadas (criadas uma vez, na primeira montagem)
// ------------------------------------------------------------------------------------------------
let _shared = null;
function shared() {
  if (_shared) return _shared;
  const ring = new THREE.RingGeometry(0.8, 1.0, 40);
  ring.rotateX(-Math.PI / 2);
  _shared = {
    ring,
    sphere: new THREE.SphereGeometry(0.5, 22, 16),
    eye: new THREE.SphereGeometry(0.06, 8, 6),
    box: new THREE.BoxGeometry(1, 1, 1),
    cylinder: new THREE.CylinderGeometry(0.5, 0.5, 1, 12),
    sack: new THREE.CylinderGeometry(0.5, 0.42, 1, 10),
    eyeMat: new THREE.MeshStandardMaterial({ color: 0x101418, roughness: 0.3 }),
    woodMat: new THREE.MeshStandardMaterial({ color: 0x6b4a2c, roughness: 0.9 }),
  };
  return _shared;
}

/**
 * Bloco de caixa com escala e posição (geometria unitária compartilhada).
 * @param {THREE.Material} mat
 * @param {number} sx @param {number} sy @param {number} sz
 * @param {number} x @param {number} y @param {number} z
 * @returns {THREE.Mesh}
 */
function block(mat, sx, sy, sz, x, y, z) {
  const m = new THREE.Mesh(shared().box, mat);
  m.scale.set(sx, sy, sz);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

// ------------------------------------------------------------------------------------------------
// Visuais (estratégia por modelo.tipo / forma). Interface comum:
//   locomotion(e, dt, elapsed, moving) · telegraph(e, k) · attack(e, k) · onState(e, state) · death(e, k)
//   reset(e) · setFlash(v) · hit(e, dirX, dirZ, force)
// ------------------------------------------------------------------------------------------------
class BaseVisual {
  constructor() {
    /** @type {THREE.MeshStandardMaterial[]} */
    this.flashMats = [];
    this.flashValue = 0;
    this.phase = Math.random() * 6.28;
  }

  /** @param {number} v 0..1 */
  setFlash(v) {
    if (v === this.flashValue || (v > 0 && Math.abs(v - this.flashValue) < 0.01)) return;
    this.flashValue = v;
    for (let i = 0; i < this.flashMats.length; i++) this.flashMats[i].emissive.setRGB(v * 0.9, v * 0.32, v * 0.22);
  }

  /** @param {Enemy} e @param {number} dt @param {number} elapsed @param {boolean} moving */
  locomotion(e, dt, elapsed, moving) {} // eslint-disable-line no-unused-vars
  /** @param {Enemy} e @param {number} k */
  telegraph(e, k) {} // eslint-disable-line no-unused-vars
  /** @param {Enemy} e @param {number} k */
  attack(e, k) {} // eslint-disable-line no-unused-vars
  /** @param {Enemy} e @param {number} state */
  onState(e, state) {} // eslint-disable-line no-unused-vars
  /** @param {Enemy} e @param {number} dirX @param {number} dirZ @param {number} force */
  hit(e, dirX, dirZ, force) {} // eslint-disable-line no-unused-vars

  /** @param {Enemy} e @param {number} k 0..1 ao longo de DEATH_FADE */
  death(e, k) {
    const b = e.body;
    b.rotation.z = Math.min(1, k * 4) * (Math.PI / 2) * 0.95;
    b.position.y = -Math.max(0, k - 0.45) * 1.8 * e.height;
  }

  /** @param {Enemy} e */
  reset(e) {
    const b = e.body;
    b.position.set(0, 0, 0);
    b.rotation.set(0, 0, 0);
    b.scale.set(1, 1, 1);
    this.setFlash(0);
  }
}

/** Animais Kenney (javali, lobo): pernas por nó, bote no golpe, encolhe no telégrafo. */
class QuadrupedVisual extends BaseVisual {
  /** @param {Enemy} e @param {THREE.Object3D} model */
  constructor(e, model) {
    super();
    const tint = e.def.modelo.tint ? new THREE.Color(e.def.modelo.tint) : null;
    model.traverse((o) => {
      if (!o.isMesh) return;
      o.material = o.material.clone();
      if (tint) o.material.color.copy(tint);
      if (o.material.emissive) this.flashMats.push(o.material);
      o.castShadow = true;
      o.receiveShadow = false;
    });
    fitToHeight(model, e.height);
    e.body.add(model);
    this.rig = new QuadrupedRig(model);
  }

  locomotion(e, dt, elapsed, moving) {
    if (e.state === S.TELEGRAPH || e.state === S.ATTACK) return;
    e.body.rotation.z *= Math.exp(-10 * dt);
    if (moving) {
      const fast = e.speed > e.def.velocidade.patrulha * 1.4;
      this.phase += dt * (fast ? 13 : 7) * Math.max(0.6, e.speed / Math.max(0.1, e.def.velocidade.perseguicao) + 0.4);
      this.rig.step(this.phase, fast ? 0.8 : 0.45, fast ? 0.08 : 0.04);
      e.body.rotation.x = fast ? 0.06 : 0;
    } else {
      this.rig.rest();
      e.body.rotation.x = 0;
      // respiração
      e.body.scale.y = 1 + Math.sin(elapsed * 2.4 + this.phase) * 0.02;
    }
  }

  telegraph(e, k) {
    // Abaixa a frente e treme, pronto para o bote
    e.body.rotation.x = 0.16 * k;
    e.body.position.z = -0.18 * k * e.height + Math.sin(k * 60) * 0.015;
    e.body.scale.y = 1 - 0.1 * k;
    this.rig.hop(0.35 * k);
  }

  attack(e, k) {
    const arc = Math.sin(k * Math.PI);
    e.body.position.z = arc * 0.55 * e.height;
    e.body.position.y = arc * 0.18 * e.height;
    e.body.rotation.x = -0.25 * arc;
    e.body.scale.y = 1 + 0.08 * arc;
    this.rig.hop(arc);
  }

  onState(e, state) {
    if (state !== S.TELEGRAPH && state !== S.ATTACK) {
      e.body.position.set(0, 0, 0);
      e.body.scale.set(1, 1, 1);
    }
  }

  hit(e, dirX, dirZ, force) {
    e.body.rotation.z = (Math.random() - 0.5) * 0.3 * Math.min(1, force + 0.3);
  }

  reset(e) {
    super.reset(e);
    this.rig.rest();
  }
}

/** Personagem KayKit (esqueleto): animações do esqueleto padrão e arma presa na mão direita. */
class CharacterVisual extends BaseVisual {
  /** @param {Enemy} e @param {import("./characters.js").Character} character */
  constructor(e, character) {
    super();
    this.character = character;
    e.body.add(character.root);
    character.root.traverse((o) => {
      if (o.isMesh && o.material && o.material.emissive && !this.flashMats.includes(o.material)) this.flashMats.push(o.material);
    });
    this.loco = "";
    const chop = character.duration("1H_Melee_Attack_Chop");
    this.chopDur = chop > 0 ? chop : 1.0;
    this.play("Idle");
  }

  /** @param {string} name */
  play(name) {
    if (this.loco === name) return;
    this.loco = name;
    this.character.play(name, PLAY_LOOP);
  }

  locomotion(e, dt, elapsed, moving) {
    if (e.state === S.TELEGRAPH || e.state === S.ATTACK || e.state === S.HURT) {
      this.character.update(dt);
      return;
    }
    if (!moving) this.play("Idle");
    else if (e.speed > e.def.velocidade.patrulha * 1.4) this.play("Running_A");
    else this.play("Walking_B");
    this.character.update(dt);
  }

  onState(e, state) {
    if (state === S.TELEGRAPH) {
      // O impacto do golpe (~42% do clipe) cai no fim do telégrafo
      _attackOpts.timeScale = Math.max(0.3, (this.chopDur * 0.42) / Math.max(0.15, e.def.telegrafo));
      this.loco = "1H_Melee_Attack_Chop";
      this.character.play("1H_Melee_Attack_Chop", _attackOpts);
    } else if (state === S.HURT) {
      this.loco = "Hit_A";
      this.character.play("Hit_A", PLAY_HIT);
    } else if (state === S.DEAD) {
      this.loco = "Death_A";
      this.character.play("Death_A", PLAY_DEATH);
    } else if (state === S.ALERT) {
      this.play("Idle");
    }
  }

  telegraph(e, k) {
    e.body.position.z = Math.sin(k * 50) * 0.01;
  }

  attack(e, k) {
    e.body.position.z = Math.sin(k * Math.PI) * 0.25;
  }

  death(e, k) {
    this.character.update(1 / 60);
    e.body.position.y = -Math.max(0, k - 0.55) * 1.6;
  }

  reset(e) {
    super.reset(e);
    this.loco = "";
    this.play("Idle");
  }
}

/** Slime translúcido: anda aos pulinhos com squash-and-stretch, salta no golpe. */
class SlimeVisual extends BaseVisual {
  /** @param {Enemy} e */
  constructor(e) {
    super();
    const sh = shared();
    const color = new THREE.Color(e.def.modelo.cor || "#5fd8c0");
    this.mat = new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.72, roughness: 0.12, metalness: 0.0, emissive: color.clone().multiplyScalar(0.12), depthWrite: false });
    this.coreMat = new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.45), roughness: 0.4, emissive: color.clone().multiplyScalar(0.2) });
    this.baseEmissive = this.mat.emissive.clone();
    this.flashMats.push(this.coreMat);
    const h = e.height;
    this.jelly = new THREE.Group();
    const skin = new THREE.Mesh(sh.sphere, this.mat);
    skin.scale.set(1.25, 1, 1.25);
    skin.position.y = 0.5;
    skin.castShadow = true;
    skin.renderOrder = 2;
    const core = new THREE.Mesh(sh.sphere, this.coreMat);
    core.scale.setScalar(0.42);
    core.position.y = 0.42;
    const eyeL = new THREE.Mesh(sh.eye, sh.eyeMat);
    const eyeR = new THREE.Mesh(sh.eye, sh.eyeMat);
    eyeL.position.set(-0.16, 0.62, 0.52);
    eyeR.position.set(0.16, 0.62, 0.52);
    this.jelly.add(core, skin, eyeL, eyeR);
    this.jelly.scale.setScalar(h);
    this.base = h;
    e.body.add(this.jelly);
  }

  /** @param {number} sy */
  squash(sy) {
    const sxz = 1 / Math.sqrt(Math.max(0.05, sy));
    this.jelly.scale.set(this.base * sxz, this.base * sy, this.base * sxz);
  }

  locomotion(e, dt, elapsed, moving) {
    if (e.state === S.TELEGRAPH || e.state === S.ATTACK) return;
    if (moving) {
      this.phase += dt * (6 + e.speed * 2.2);
      const s = Math.abs(Math.sin(this.phase));
      e.body.position.y = s * 0.28 * e.height;
      this.squash(1 + 0.22 * s - 0.18 * (1 - s));
    } else {
      e.body.position.y = 0;
      this.squash(1 + Math.sin(elapsed * 3.1 + this.phase) * 0.05);
    }
  }

  telegraph(e, k) {
    e.body.position.y = 0;
    this.squash(1 - 0.38 * k + Math.sin(k * 70) * 0.02);
    this.mat.emissive.copy(this.baseEmissive).multiplyScalar(1 + 5 * k);
  }

  attack(e, k) {
    const arc = Math.sin(k * Math.PI);
    e.body.position.z = arc * 0.9;
    e.body.position.y = arc * 0.45 * e.height;
    this.squash(1 + 0.3 * arc);
  }

  onState(e, state) {
    if (state !== S.TELEGRAPH && state !== S.ATTACK) {
      e.body.position.z = 0;
      this.mat.emissive.copy(this.baseEmissive);
    }
  }

  hit(e) {
    this.squash(0.7);
  }

  death(e, k) {
    e.body.position.y = 0;
    this.squash(Math.max(0.08, 1 - k * 1.6));
    this.mat.opacity = 0.72 * Math.max(0, 1 - k * 1.2);
    this.coreMat.opacity = Math.max(0, 1 - k * 1.4);
    this.coreMat.transparent = true;
  }

  reset(e) {
    super.reset(e);
    this.mat.opacity = 0.72;
    this.coreMat.opacity = 1;
    this.coreMat.transparent = false;
    this.mat.emissive.copy(this.baseEmissive);
    this.squash(1);
  }
}

/** Guardião Rúnico: golem de blocos de pedra com runas ciano; ergue os braços no telégrafo e esmaga o chão. */
class GolemVisual extends BaseVisual {
  /** @param {Enemy} e */
  constructor(e) {
    super();
    const stone = new THREE.MeshStandardMaterial({ color: new THREE.Color(e.def.modelo.cor || "#5b6470"), roughness: 0.92, metalness: 0.02, flatShading: true });
    const runeColor = new THREE.Color(e.def.modelo.emissivo || "#46e8ff");
    this.rune = new THREE.MeshStandardMaterial({ color: runeColor, emissive: runeColor, emissiveIntensity: 1.6, roughness: 0.3 });
    this.flashMats.push(stone);
    const g = new THREE.Group();
    // Pernas (pivô no quadril)
    this.legL = new THREE.Group();
    this.legR = new THREE.Group();
    this.legL.position.set(-0.24, 0.8, 0);
    this.legR.position.set(0.24, 0.8, 0);
    this.legL.add(block(stone, 0.3, 0.8, 0.34, 0, -0.4, 0));
    this.legR.add(block(stone, 0.3, 0.8, 0.34, 0, -0.4, 0));
    this.torso = new THREE.Group();
    this.torso.position.y = 0.8;
    this.torso.add(block(stone, 0.7, 0.2, 0.42, 0, 0.06, 0));
    this.torso.add(block(stone, 0.95, 0.62, 0.56, 0, 0.47, 0));
    this.torso.add(block(this.rune, 0.48, 0.07, 0.03, 0, 0.55, 0.29));
    this.torso.add(block(this.rune, 0.07, 0.36, 0.03, 0, 0.42, 0.29));
    this.torso.add(block(stone, 0.32, 0.3, 0.34, 0, 0.93, 0.02));
    this.torso.add(block(this.rune, 0.07, 0.05, 0.03, -0.08, 0.95, 0.2));
    this.torso.add(block(this.rune, 0.07, 0.05, 0.03, 0.08, 0.95, 0.2));
    // Braços (pivô no ombro)
    this.armL = new THREE.Group();
    this.armR = new THREE.Group();
    this.armL.position.set(-0.62, 0.68, 0);
    this.armR.position.set(0.62, 0.68, 0);
    for (const arm of [this.armL, this.armR]) {
      arm.add(block(stone, 0.28, 0.5, 0.3, 0, -0.25, 0));
      arm.add(block(stone, 0.38, 0.34, 0.38, 0, -0.64, 0.02));
      arm.add(block(this.rune, 0.3, 0.05, 0.03, 0, -0.62, 0.21));
    }
    this.torso.add(this.armL, this.armR);
    g.add(this.legL, this.legR, this.torso);
    g.scale.setScalar(e.height / 1.76);
    e.body.add(g);
    this.model = g;
    this.armBase = 0;
  }

  /** @param {number} v */
  arms(v) {
    this.armL.rotation.x = v;
    this.armR.rotation.x = v;
  }

  locomotion(e, dt, elapsed, moving) {
    this.rune.emissiveIntensity = 1.4 + Math.sin(elapsed * 2.1) * 0.5;
    if (e.state === S.TELEGRAPH || e.state === S.ATTACK) return;
    if (moving) {
      this.phase += dt * (2.4 + e.speed * 1.4);
      const s = Math.sin(this.phase);
      this.legL.rotation.x = s * 0.42;
      this.legR.rotation.x = -s * 0.42;
      this.arms(0);
      this.armL.rotation.x = -s * 0.3;
      this.armR.rotation.x = s * 0.3;
      this.torso.position.y = 0.8 + Math.abs(s) * 0.04;
      this.torso.rotation.z = s * 0.04;
    } else {
      this.legL.rotation.x = 0;
      this.legR.rotation.x = 0;
      this.arms(Math.sin(elapsed * 0.9) * 0.05);
      this.torso.position.y = 0.8 + Math.sin(elapsed * 1.3) * 0.015;
      this.torso.rotation.z = 0;
    }
  }

  telegraph(e, k) {
    // Ergue os dois braços acima da cabeça; as runas acendem
    this.arms(-2.6 * Math.min(1, k * 1.3));
    this.torso.rotation.x = -0.12 * k;
    this.rune.emissiveIntensity = 1.6 + 4.5 * k;
    e.body.position.x = Math.sin(k * 80) * 0.02 * k;
  }

  attack(e, k) {
    const slam = Math.min(1, k * 2.2);
    this.arms(-2.6 + 2.9 * slam);
    this.torso.rotation.x = 0.28 * slam;
    this.rune.emissiveIntensity = 6 - 4 * k;
  }

  onState(e, state) {
    if (state !== S.TELEGRAPH && state !== S.ATTACK) {
      this.torso.rotation.x = 0;
      e.body.position.x = 0;
    }
  }

  death(e, k) {
    // Tomba para trás e afunda; as runas apagam
    e.body.rotation.x = -Math.min(1, k * 2.5) * 1.35;
    e.body.position.y = -Math.max(0, k - 0.5) * 1.6 * e.height;
    this.rune.emissiveIntensity = Math.max(0, 2 * (1 - k * 1.5));
  }

  reset(e) {
    super.reset(e);
    this.arms(0);
    this.torso.rotation.set(0, 0, 0);
    this.rune.emissiveIntensity = 1.6;
  }
}

/** Boneco de treino: poste + saco de palha que balança (mola amortecida) ao ser golpeado. */
class DummyVisual extends BaseVisual {
  /** @param {Enemy} e */
  constructor(e) {
    super();
    const sh = shared();
    const straw = new THREE.MeshStandardMaterial({ color: new THREE.Color(e.def.modelo.cor || "#a4794a"), roughness: 0.95 });
    this.flashMats.push(straw);
    const h = e.height;
    const base = new THREE.Mesh(sh.cylinder, sh.woodMat);
    base.scale.set(0.6, 0.08, 0.6);
    base.position.y = 0.04;
    this.swing = new THREE.Group();
    const post = new THREE.Mesh(sh.cylinder, sh.woodMat);
    post.scale.set(0.13, h * 0.97, 0.13);
    post.position.y = h * 0.485;
    const bar = block(sh.woodMat, 0.95, 0.07, 0.07, 0, h * 0.74, 0);
    const sack = new THREE.Mesh(sh.sack, straw);
    sack.scale.set(0.46, h * 0.4, 0.4);
    sack.position.y = h * 0.56;
    const head = new THREE.Mesh(sh.sphere, straw);
    head.scale.set(0.36, 0.34, 0.34);
    head.position.y = h * 0.88;
    for (const m of [base, post, sack, head]) m.castShadow = true;
    this.swing.add(post, bar, sack, head);
    e.body.add(base, this.swing);
    this.ax = 0;
    this.az = 0;
    this.vx = 0;
    this.vz = 0;
  }

  /** @param {Enemy} e @param {number} dirX @param {number} dirZ @param {number} force */
  hit(e, dirX, dirZ, force) {
    // Impulso no sentido do golpe, convertido para o espaço local (o boneco não gira)
    const c = Math.cos(-e.yaw);
    const s = Math.sin(-e.yaw);
    const lx = dirX * c + dirZ * s;
    const lz = -dirX * s + dirZ * c;
    const imp = 2.2 + Math.min(3, force * 2);
    this.vx += lz * imp;
    this.vz -= lx * imp;
  }

  locomotion(e, dt) {
    // Mola amortecida (sem alocação): ângulo -> 0
    this.vx += (-40 * this.ax - 5 * this.vx) * dt;
    this.vz += (-40 * this.az - 5 * this.vz) * dt;
    this.ax += this.vx * dt;
    this.az += this.vz * dt;
    this.swing.rotation.x = this.ax;
    this.swing.rotation.z = this.az;
  }

  death(e, k) {
    // "Derrubado": deita e levanta de novo quando regenera
    this.locomotion(e, 1 / 60);
    this.swing.rotation.x = Math.min(1, k * 6) * 1.1;
  }

  reset(e) {
    super.reset(e);
    this.ax = 0;
    this.az = 0;
    this.vx = 0;
    this.vz = 0;
    this.swing.rotation.set(0, 0, 0);
  }
}

// ------------------------------------------------------------------------------------------------
// Inimigo
// ------------------------------------------------------------------------------------------------
export class Enemy {
  /**
   * @param {EnemySpawn} spawn
   * @param {object} def entrada de enemies.json
   * @param {EnemySystem} system
   */
  constructor(spawn, def, system) {
    this.id = spawn.id;
    this.type = spawn.tipo;
    this.def = def;
    this.spawn = spawn;
    this.system = system;
    this.training = Boolean(def.treino);
    this.elite = Boolean(def.elite);
    this.name = def.nome || spawn.tipo;
    this.radius = def.raio;
    this.height = def.altura;
    this.maxHp = def.vida;
    this.hp = def.vida;
    this.alive = true;
    this.root = new THREE.Group();
    this.root.name = `Enemy_${spawn.id}`;
    this.body = new THREE.Group();
    this.root.add(this.body);
    this.root.position.set(spawn.x, 0, spawn.z);
    this.yaw = spawn.yaw || 0;
    this.root.rotation.y = this.yaw;
    this.homeX = spawn.x;
    this.homeZ = spawn.z;
    this.leash = spawn.leash ?? 14;
    this.patrol = spawn.patrulha && spawn.patrulha.length ? spawn.patrulha : null;
    this.patrolIdx = 0;
    this.wanderX = spawn.x;
    this.wanderZ = spawn.z;
    this.state = S.PATROL;
    this.stateTime = 0;
    this.wait = Math.random() * 2;
    this.cooldown = 0;
    this.speed = 0;
    this.moveX = 0;
    this.moveZ = 0;
    this.targetYaw = this.yaw;
    this.turnRate = this.elite ? 3.2 : 8;
    this.kbX = 0;
    this.kbZ = 0;
    this.stagger = 0;
    this.struck = false;
    this.sinceHit = 99;
    this.deadTime = 0;
    this.stuck = 0;
    this.flash = 0;
    this.voiceTimer = 4 + Math.random() * 8;
    this.distPlayer = Infinity;
    this.active = false;
    this.voice = VOICE_BY_TYPE[spawn.tipo] || VOICE_BY_SHAPE[def.modelo.forma] || VOICE_BY_SHAPE[def.modelo.tipo] || "";
    /** @type {BaseVisual} */
    this.visual = null;
    /** @type {THREE.Mesh | null} */
    this.ring = null;
    this.ringFx = 0;
    this.result = { dealt: 0, killed: false };
  }

  /**
   * Golpe do jogador (CombatSystem).
   * @param {number} amount dano
   * @param {number} dirX direção do golpe (do jogador para o inimigo)
   * @param {number} dirZ
   * @param {number} knock empurrão em metros antes da resistência
   * @returns {{dealt: number, killed: boolean}}
   */
  hit(amount, dirX, dirZ, knock) {
    return this.system.applyHit(this, amount, dirX, dirZ, knock);
  }

  /** true se está brigando com o jogador. */
  get engaged() {
    return this.alive && !this.training && (this.state === S.ALERT || this.state === S.CHASE || this.state === S.TELEGRAPH || this.state === S.ATTACK || this.state === S.HURT);
  }
}

/** @param {Enemy} a @param {Enemy} b */
function byDistance(a, b) {
  return a.distPlayer - b.distPlayer;
}

// ------------------------------------------------------------------------------------------------
// Barras de vida (pool de DOM criado uma vez; CSS próprio injetado)
// ------------------------------------------------------------------------------------------------
const BAR_CSS = `
#enemy-bars{position:fixed;inset:0;pointer-events:none;z-index:6;overflow:hidden}
#enemy-bars .eb{position:absolute;left:0;top:0;width:64px;display:none;flex-direction:column;align-items:center;will-change:transform;
  font:600 11px/1.25 Georgia,"Times New Roman",serif;color:#f3e6cf;text-shadow:0 1px 2px #000,0 0 6px rgba(0,0,0,.6)}
#enemy-bars .eb-name{margin-bottom:3px;white-space:nowrap;letter-spacing:.05em;display:none}
#enemy-bars .eb-track{width:100%;height:6px;background:rgba(12,9,7,.78);border:1px solid rgba(255,232,196,.35);border-radius:3px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.5)}
#enemy-bars .eb-fill{height:100%;width:100%;background:linear-gradient(#e8624a,#9f2a1c);transform-origin:left center;transition:transform .12s linear}
#enemy-bars .eb[data-elite="1"]{width:168px}
#enemy-bars .eb[data-elite="1"] .eb-name{display:block;color:#bff6ff;font-size:13px}
#enemy-bars .eb[data-elite="1"] .eb-track{height:9px;border-color:rgba(120,235,255,.6)}
#enemy-bars .eb[data-elite="1"] .eb-fill{background:linear-gradient(#5be9ff,#2a7fb0)}
#enemy-bars .eb[data-training="1"] .eb-name{display:block}
#enemy-bars .eb[data-training="1"] .eb-fill{background:linear-gradient(#f0cf72,#b5882c)}
`;

class EnemyBars {
  /** @param {number} size */
  constructor(size) {
    if (!document.getElementById("enemy-bars-style")) {
      const style = document.createElement("style");
      style.id = "enemy-bars-style";
      style.textContent = BAR_CSS;
      document.head.appendChild(style);
    }
    let root = document.getElementById("enemy-bars");
    if (!root) {
      root = document.createElement("div");
      root.id = "enemy-bars";
      root.setAttribute("aria-hidden", "true");
      document.body.appendChild(root);
    }
    this.root = root;
    this.slots = [];
    for (let i = 0; i < size; i++) {
      const el = document.createElement("div");
      el.className = "eb";
      el.innerHTML = '<div class="eb-name"></div><div class="eb-track"><div class="eb-fill"></div></div>';
      root.appendChild(el);
      this.slots.push({ el, name: el.firstChild, fill: el.lastChild.firstChild, key: "", shown: false, x: -1, y: -1, frac: -1 });
    }
  }

  /**
   * @param {Enemy[]} list inimigos já ordenados por distância (até slots.length)
   * @param {number} count
   * @param {THREE.Camera} camera
   * @param {number} w
   * @param {number} h
   */
  render(list, count, camera, w, h) {
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      const e = i < count ? list[i] : null;
      if (e) {
        const p = e.root.position;
        _proj.set(p.x, p.y + e.height + (e.elite ? 0.6 : 0.4), p.z).project(camera);
        if (_proj.z < 1 && _proj.z > -1) {
          const x = Math.round((_proj.x * 0.5 + 0.5) * w);
          const y = Math.round((-_proj.y * 0.5 + 0.5) * h);
          if (!slot.shown) {
            slot.el.style.display = "flex";
            slot.shown = true;
          }
          if (slot.key !== e.id) {
            slot.key = e.id;
            slot.name.textContent = e.name;
            slot.el.dataset.elite = e.elite ? "1" : "0";
            slot.el.dataset.training = e.training ? "1" : "0";
          }
          const frac = Math.round((Math.max(0, e.hp) / e.maxHp) * 200) / 200;
          if (frac !== slot.frac) {
            slot.frac = frac;
            slot.fill.style.transform = `scaleX(${frac})`;
          }
          if (x !== slot.x || y !== slot.y) {
            slot.x = x;
            slot.y = y;
            slot.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
          }
          continue;
        }
      }
      if (slot.shown) {
        slot.el.style.display = "none";
        slot.shown = false;
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Sistema
// ------------------------------------------------------------------------------------------------
export class EnemySystem {
  /**
   * @param {{scene: THREE.Scene, factory: import("./characters.js").CharacterFactory, world: import("./world.js").WorldIndex, defs: object, audio: {fx: (name: string, pos?: THREE.Vector3 | null, gain?: number) => void} | null}} opts
   */
  constructor({ scene, factory, world, defs, audio }) {
    this.scene = scene;
    this.factory = factory;
    this.world = world;
    this.defs = (defs && defs.inimigos) || defs || {};
    this.audio = audio || null;
    /** @type {Enemy[]} array estável (nunca recriado) */
    this.targets = [];
    /** @type {((enemy: Enemy) => void) | null} */
    this.onKill = null;
    /** @type {PlayerTarget | null} */
    this.playerTarget = null;
    this.wallRect = world.city.terrain;
    this.bars = null;
    /** @type {Enemy[]} */
    this._barList = [];
  }

  /** Carrega modelos e cria os inimigos de world.city.enemySpawns. */
  async init() {
    this.bars = new EnemyBars(BAR_POOL);
    const spawns = this.world.city.enemySpawns || [];
    const built = await Promise.all(spawns.map((sp) => this.build(sp).catch((err) => {
      console.warn(`[Alvor] Inimigo ${sp.id} indisponível:`, err);
      return null;
    })));
    for (const e of built) {
      if (!e) continue;
      this.scene.add(e.root);
      this.targets.push(e);
    }
  }

  /**
   * @param {EnemySpawn} spawn
   * @returns {Promise<Enemy | null>}
   */
  async build(spawn) {
    const def = this.defs[spawn.tipo];
    if (!def) {
      console.warn(`[Alvor] Tipo de inimigo desconhecido: ${spawn.tipo} (${spawn.id})`);
      return null;
    }
    const e = new Enemy(spawn, def, this);
    const m = def.modelo || { tipo: "procedural", forma: "slime" };
    if (m.tipo === "glb") {
      e.visual = new QuadrupedVisual(e, await loadModel(this.factory, m.url));
    } else if (m.tipo === "personagem") {
      const hide = [...(m.ocultar || []), ...(m.arma ? KAYKIT_GEAR : [])];
      const character = await this.factory.create({ model: m.corpo || "Knight", scale: m.escala || 0.8, recolor: m.recolor || null, hide });
      e.visual = new CharacterVisual(e, character);
      if (m.arma) await this.arm(character, m.arma);
    } else if (m.forma === "golem_runico") {
      e.visual = new GolemVisual(e);
    } else if (m.forma === "boneco_treino") {
      e.visual = new DummyVisual(e);
    } else {
      e.visual = new SlimeVisual(e);
    }
    const ringMat = new THREE.MeshBasicMaterial({ color: e.elite ? 0xff7a3a : 0xff4a2e, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
    e.ring = new THREE.Mesh(shared().ring, ringMat);
    e.ring.position.y = 0.04;
    e.ring.visible = false;
    e.ring.renderOrder = 3;
    e.root.add(e.ring);
    return e;
  }

  /**
   * Arma na mão direita: API do characters.js (factory.loadProp + character.attach) quando existir; senão
   * carrega o glTF aqui e prende no osso "handslot.r" do esqueleto KayKit.
   * @param {import("./characters.js").Character} character
   * @param {string} url
   */
  async arm(character, url) {
    const prop = await loadModel(this.factory, url);
    const s = Math.min(1, 1.6 / Math.max(0.01, maxDimension(prop)));
    prop.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });
    if (typeof character.attach === "function" && character.attach(prop, "handslot.r")) {
      prop.scale.multiplyScalar(s);
      return;
    }
    const slot = character.root.getObjectByName("handslot.r");
    if (!slot) return;
    prop.scale.setScalar(s);
    slot.add(prop);
  }

  /** @param {PlayerTarget} target */
  setPlayerTarget(target) {
    this.playerTarget = target;
  }

  /** true se algum inimigo vivo está em alerta/perseguição/ataque contra o jogador */
  get engaged() {
    for (let i = 0; i < this.targets.length; i++) if (this.targets[i].engaged) return true;
    return false;
  }

  /**
   * @param {string} id
   * @returns {Enemy | null}
   */
  get(id) {
    for (let i = 0; i < this.targets.length; i++) if (this.targets[i].id === id) return this.targets[i];
    return null;
  }

  /**
   * @param {string} name
   * @param {Enemy} e
   */
  sound(name, e) {
    if (!name || !this.audio || typeof this.audio.fx !== "function") return;
    const p = e.root.position;
    _soundPos.set(p.x, p.y + e.height * 0.6, p.z);
    this.audio.fx(name, _soundPos);
  }

  /**
   * @param {Enemy} e
   * @param {number} state
   */
  setState(e, state) {
    if (e.state === state) return;
    e.state = state;
    e.stateTime = 0;
    if (state !== S.TELEGRAPH && e.ring) {
      if (e.ringFx <= 0) e.ring.visible = false;
    }
    e.visual.onState(e, state);
  }

  /**
   * Aplica um golpe do jogador (Enemy.hit chama aqui).
   * @param {Enemy} e
   * @param {number} amount
   * @param {number} dirX
   * @param {number} dirZ
   * @param {number} knock
   * @returns {{dealt: number, killed: boolean}}
   */
  applyHit(e, amount, dirX, dirZ, knock) {
    const res = e.result;
    res.dealt = 0;
    res.killed = false;
    if (!e.alive || !(amount > 0)) return res;
    let len = Math.hypot(dirX, dirZ);
    if (len < 1e-4 && this.playerTarget) {
      dirX = e.root.position.x - this.playerTarget.position.x;
      dirZ = e.root.position.z - this.playerTarget.position.z;
      len = Math.hypot(dirX, dirZ);
    }
    if (len > 1e-4) {
      dirX /= len;
      dirZ /= len;
    } else {
      dirX = 0;
      dirZ = 1;
    }
    const dealt = Math.min(amount, e.hp);
    e.hp -= dealt;
    res.dealt = dealt;
    e.sinceHit = 0;
    e.flash = 1;
    const resist = Math.max(0, Math.min(1, e.def.knockback_resist || 0));
    e.visual.hit(e, dirX, dirZ, (knock || 0) * (1 - resist));
    if (e.training) {
      this.sound("dummyHit", e);
      if (e.hp <= 0) {
        res.killed = true;
        this.kill(e);
      }
      return res;
    }
    // Empurrão em metros (velocidade inicial com decaimento exponencial de taxa 6 percorre 'knock')
    const push = (knock || 0) * (1 - resist) * 6;
    e.kbX += dirX * push;
    e.kbZ += dirZ * push;
    if (e.hp <= 0) {
      res.killed = true;
      this.kill(e);
      return res;
    }
    if (e.voiceTimer > 1.2) {
      this.sound(e.voice, e);
      e.voiceTimer = 1.2;
    }
    if (resist >= 0.8 && (e.state === S.TELEGRAPH || e.state === S.ATTACK)) return res;   // elite: não é interrompido
    e.stagger = 0.16 + 0.3 * (1 - resist);
    this.setState(e, S.HURT);
    return res;
  }

  /** @param {Enemy} e */
  kill(e) {
    e.alive = false;
    e.hp = 0;
    e.deadTime = 0;
    e.speed = 0;
    e.kbX *= 0.5;
    e.kbZ *= 0.5;
    e.ring.visible = false;
    e.ringFx = 0;
    this.setState(e, S.DEAD);
    if (!e.training) {
      this.sound("enemyDeath", e);
      if (this.onKill) this.onKill(e);
    }
  }

  /** @param {Enemy} e */
  respawn(e) {
    e.alive = true;
    e.hp = e.maxHp;
    e.root.position.set(e.homeX, 0, e.homeZ);
    e.yaw = e.spawn.yaw || 0;
    e.targetYaw = e.yaw;
    e.root.rotation.y = e.yaw;
    e.kbX = 0;
    e.kbZ = 0;
    e.speed = 0;
    e.cooldown = 0;
    e.patrolIdx = 0;
    e.wait = 1 + Math.random() * 2;
    e.root.visible = true;
    e.visual.reset(e);
    e.state = S.DEAD;
    this.setState(e, S.PATROL);
  }

  /**
   * @param {number} dt
   * @param {number} elapsed
   * @param {THREE.Camera} camera
   * @param {number} viewW
   * @param {number} viewH
   */
  update(dt, elapsed, camera, viewW, viewH) {
    const pt = this.playerTarget;
    const cam = camera.position;
    const list = this.targets;
    const view2 = VIEW_DIST * VIEW_DIST;
    const anim2 = ANIM_DIST * ANIM_DIST;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const p = e.root.position;
      e.distPlayer = pt ? Math.hypot(p.x - pt.position.x, p.z - pt.position.z) : Infinity;
      const dc2 = (p.x - cam.x) ** 2 + (p.z - cam.z) ** 2;
      if (!e.alive) {
        this.updateDead(e, dt, dc2 < anim2);
        continue;
      }
      const visible = dc2 < view2;
      if (e.root.visible !== visible) e.root.visible = visible;
      e.voiceTimer -= dt;
      e.sinceHit += dt;
      e.active = e.engaged || e.distPlayer < AI_DIST || e.state === S.RETURN;
      if (e.training) {
        this.updateDummy(e, dt);
      } else if (e.active) {
        this.think(e, dt);
        this.move(e, dt);
      }
      if (e.flash > 0) {
        e.flash = Math.max(0, e.flash - dt * 5);
        e.visual.setFlash(e.flash);
      }
      if (visible && dc2 < anim2) this.animate(e, dt, elapsed);
    }
    this.separate();
    this.renderBars(camera, viewW, viewH);
  }

  /**
   * @param {Enemy} e
   * @param {number} dt
   * @param {boolean} animate
   */
  updateDead(e, dt, animate) {
    e.deadTime += dt;
    const p = e.root.position;
    if (e.kbX || e.kbZ) {
      p.x += e.kbX * dt;
      p.z += e.kbZ * dt;
      const decay = Math.exp(-6 * dt);
      e.kbX *= decay;
      e.kbZ *= decay;
      if (Math.abs(e.kbX) + Math.abs(e.kbZ) < 0.02) {
        e.kbX = 0;
        e.kbZ = 0;
      }
      resolveCircle(p, e.radius, this.world);
      pushOutOfRect(p, this.wallRect, e.radius);
    }
    const fade = e.training ? Math.min(1, e.deadTime / Math.max(0.5, e.def.respawn || 2)) : Math.min(1, e.deadTime / DEATH_FADE);
    if (animate && e.root.visible) e.visual.death(e, fade);
    if (!e.training && e.deadTime > DEATH_FADE && e.root.visible) e.root.visible = false;
    const wait = Math.max(e.training ? 0.5 : DEATH_FADE + 0.5, e.def.respawn || 30);
    if (e.deadTime < wait) return;
    const pt = this.playerTarget;
    if (!e.training && pt && Math.hypot(e.homeX - pt.position.x, e.homeZ - pt.position.z) < RESPAWN_CLEAR) return;
    this.respawn(e);
  }

  /**
   * Boneco: não pensa; volta à vida cheia 2 s depois do último golpe.
   * @param {Enemy} e
   * @param {number} dt
   */
  updateDummy(e, dt) {
    if (e.hp < e.maxHp && e.sinceHit > DUMMY_REGEN_DELAY) e.hp = Math.min(e.maxHp, e.hp + e.maxHp * 1.6 * dt);
    const pt = this.playerTarget;
    if (!pt) return;
    // O jogador não atravessa o boneco (estático): quem desliza é ele
    const p = e.root.position;
    const pr = pt.radius || PLAYER_RADIUS;
    const dx = pt.position.x - p.x;
    const dz = pt.position.z - p.z;
    const d = Math.hypot(dx, dz);
    const min = e.radius + pr;
    if (d < min && d > 1e-4) {
      pt.position.x = p.x + (dx / d) * min;
      pt.position.z = p.z + (dz / d) * min;
    }
  }

  /**
   * @param {Enemy} e
   * @param {number} dt
   */
  think(e, dt) {
    const def = e.def;
    const pt = this.playerTarget;
    const p = e.root.position;
    e.stateTime += dt;
    e.cooldown -= dt;
    const px = pt ? pt.position.x : 0;
    const pz = pt ? pt.position.z : 0;
    // Intramuros é refúgio: com o jogador dentro do retângulo da muralha, ninguém fica plantado no portão
    const w = this.wallRect;
    const sheltered = px > w.minX && px < w.maxX && pz > w.minZ && pz < w.maxZ;
    const playerOk = Boolean(pt && !pt.dead && !sheltered);
    const dx = px - p.x;
    const dz = pz - p.z;
    const dist = e.distPlayer;
    const homeD = Math.hypot(p.x - e.homeX, p.z - e.homeZ);
    switch (e.state) {
      case S.PATROL: {
        if (playerOk && dist < def.visao) {
          this.setState(e, S.ALERT);
          this.sound(e.voice, e);
          e.voiceTimer = 6 + Math.random() * 6;
          break;
        }
        if (e.voiceTimer <= 0) {
          if (dist < 22) this.sound(e.voice, e);
          e.voiceTimer = 7 + Math.random() * 9;
        }
        this.patrolStep(e, dt);
        break;
      }
      case S.ALERT: {
        e.speed = 0;
        e.targetYaw = Math.atan2(dx, dz);
        if (!playerOk) this.setState(e, S.RETURN);
        else if (e.stateTime >= ALERT_TIME) this.setState(e, S.CHASE);
        break;
      }
      case S.CHASE: {
        if (!playerOk || dist > def.desiste || homeD > e.leash + def.alcance_ataque) {
          this.setState(e, S.RETURN);
          break;
        }
        e.targetYaw = Math.atan2(dx, dz);
        if (dist <= def.alcance_ataque * 0.92 && e.cooldown <= 0) {
          e.speed = 0;
          this.setState(e, S.TELEGRAPH);
          e.ring.visible = true;
          e.ringFx = 0;
          this.sound("enemyTelegraph", e);
          break;
        }
        const stopAt = e.radius + (pt.radius || PLAYER_RADIUS) + 0.15;
        if (dist > stopAt) {
          e.moveX = dx / dist;
          e.moveZ = dz / dist;
          e.speed = def.velocidade.perseguicao;
        } else {
          e.speed = 0;
        }
        break;
      }
      case S.TELEGRAPH: {
        e.speed = 0;
        if (playerOk) e.targetYaw = Math.atan2(dx, dz);
        if (e.stateTime >= Math.max(0.1, def.telegrafo)) {
          e.struck = false;
          this.setState(e, S.ATTACK);
          this.sound("enemyAttack", e);
        }
        break;
      }
      case S.ATTACK: {
        // Bote curto para frente (o golem e o esqueleto ficam plantados)
        const lunge = e.def.modelo.tipo === "glb" || e.def.modelo.forma === "slime";
        e.speed = lunge && e.stateTime < ATTACK_TIME * 0.6 ? def.velocidade.perseguicao * 0.9 : 0;
        e.moveX = Math.sin(e.yaw);
        e.moveZ = Math.cos(e.yaw);
        if (!e.struck && e.stateTime >= STRIKE_AT) {
          e.struck = true;
          this.strike(e);
        }
        if (e.stateTime >= ATTACK_TIME) {
          e.cooldown = def.recarga;
          this.setState(e, playerOk ? S.CHASE : S.RETURN);
        }
        break;
      }
      case S.HURT: {
        e.speed = 0;
        if (e.stateTime >= e.stagger) this.setState(e, playerOk ? S.CHASE : S.RETURN);
        break;
      }
      case S.RETURN: {
        e.hp = Math.min(e.maxHp, e.hp + e.maxHp * 0.35 * dt);
        if (homeD < 1.0) {
          e.hp = e.maxHp;
          e.patrolIdx = 0;
          this.setState(e, S.PATROL);
          break;
        }
        if (playerOk && dist < def.visao * 0.6 && homeD < e.leash * 0.5) {
          this.setState(e, S.ALERT);
          break;
        }
        e.moveX = (e.homeX - p.x) / homeD;
        e.moveZ = (e.homeZ - p.z) / homeD;
        e.targetYaw = Math.atan2(e.moveX, e.moveZ);
        e.speed = def.velocidade.patrulha * 1.6;
        break;
      }
      default:
        break;
    }
  }

  /**
   * Anda pelo laço de patrulha (ou vagueia em volta do ponto), com pausas.
   * @param {Enemy} e
   * @param {number} dt
   */
  patrolStep(e, dt) {
    const p = e.root.position;
    if (e.wait > 0) {
      e.wait -= dt;
      e.speed = 0;
      return;
    }
    let tx;
    let tz;
    if (e.patrol) {
      const t = e.patrol[e.patrolIdx % e.patrol.length];
      tx = t[0];
      tz = t[1];
    } else {
      tx = e.wanderX;
      tz = e.wanderZ;
    }
    const dx = tx - p.x;
    const dz = tz - p.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.5 || e.stuck > 2) {
      e.stuck = 0;
      e.wait = 1.2 + Math.random() * 2.8;
      e.speed = 0;
      if (e.patrol) {
        e.patrolIdx = (e.patrolIdx + 1) % e.patrol.length;
      } else {
        const a = Math.random() * Math.PI * 2;
        const r = 1.5 + Math.random() * 4;
        e.wanderX = e.homeX + Math.cos(a) * r;
        e.wanderZ = e.homeZ + Math.sin(a) * r;
      }
      return;
    }
    e.moveX = dx / d;
    e.moveZ = dz / d;
    e.targetYaw = Math.atan2(dx, dz);
    e.speed = e.def.velocidade.patrulha;
  }

  /**
   * Impacto do golpe: acerta se o jogador ainda está no alcance (e à frente, exceto o golem que esmaga em volta).
   * @param {Enemy} e
   */
  strike(e) {
    const pt = this.playerTarget;
    const def = e.def;
    if (def.modelo.forma === "golem_runico") e.ringFx = 0.45;
    if (!pt || pt.dead || pt.invulnerable || !(def.dano > 0)) return;
    const p = e.root.position;
    const dx = pt.position.x - p.x;
    const dz = pt.position.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d > def.alcance_ataque + STRIKE_GRACE) return;
    if (def.modelo.forma !== "golem_runico" && d > 1e-3) {
      const facing = (dx * Math.sin(e.yaw) + dz * Math.cos(e.yaw)) / d;
      if (facing < STRIKE_COS) return;
    }
    pt.hurt(def.dano, p.x, p.z);
  }

  /**
   * @param {Enemy} e
   * @param {number} dt
   */
  move(e, dt) {
    const p = e.root.position;
    e.yaw = turnTowards(e.yaw, e.targetYaw, e.state === S.TELEGRAPH ? e.turnRate * 0.6 : e.turnRate, dt);
    e.root.rotation.y = e.yaw;
    const px = p.x;
    const pz = p.z;
    if (e.speed > 0) {
      p.x += e.moveX * e.speed * dt;
      p.z += e.moveZ * e.speed * dt;
    }
    if (e.kbX || e.kbZ) {
      p.x += e.kbX * dt;
      p.z += e.kbZ * dt;
      const decay = Math.exp(-6 * dt);
      e.kbX *= decay;
      e.kbZ *= decay;
      if (Math.abs(e.kbX) + Math.abs(e.kbZ) < 0.02) {
        e.kbX = 0;
        e.kbZ = 0;
      }
    }
    if (p.x === px && p.z === pz) return;
    resolveCircle(p, e.radius, this.world);
    // Nunca intramuros: o retângulo da muralha (city.terrain) é parede para todo inimigo hostil
    pushOutOfRect(p, this.wallRect, e.radius);
    const moved = Math.hypot(p.x - px, p.z - pz);
    e.stuck = e.speed > 0 && moved < e.speed * dt * 0.3 ? e.stuck + dt : Math.max(0, e.stuck - dt);
  }

  /**
   * @param {Enemy} e
   * @param {number} dt
   * @param {number} elapsed
   */
  animate(e, dt, elapsed) {
    const v = e.visual;
    const moving = e.speed > 0.05;
    v.locomotion(e, dt, elapsed, moving);
    if (e.state === S.TELEGRAPH) {
      const k = Math.min(1, e.stateTime / Math.max(0.1, e.def.telegrafo));
      v.telegraph(e, k);
      const ring = e.ring;
      const reach = e.def.alcance_ataque + 0.2;
      ring.scale.setScalar(reach * (0.55 + 0.45 * k));
      ring.material.opacity = 0.2 + 0.65 * k * (0.75 + 0.25 * Math.sin(elapsed * 30));
    } else if (e.state === S.ATTACK) {
      v.attack(e, Math.min(1, e.stateTime / ATTACK_TIME));
    }
    if (e.ringFx > 0) {
      // Onda de choque do golem: o anel cresce e some
      e.ringFx -= dt;
      const k = 1 - Math.max(0, e.ringFx) / 0.45;
      e.ring.visible = e.ringFx > 0;
      e.ring.scale.setScalar((e.def.alcance_ataque + 0.2) * (1 + k * 1.2));
      e.ring.material.opacity = 0.8 * (1 - k);
    }
  }

  /** Inimigos não se sobrepõem (pares vivos e ativos; o boneco não se mexe) e não atravessam o jogador. */
  separate() {
    const list = this.targets;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a.alive || !a.active || a.training) continue;
      const pa = a.root.position;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (!b.alive || !b.active || b.training) continue;
        const pb = b.root.position;
        const dx = pb.x - pa.x;
        const dz = pb.z - pa.z;
        const min = a.radius + b.radius;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min || d2 < 1e-8) continue;
        const d = Math.sqrt(d2);
        const push = (min - d) * 0.5;
        const nx = dx / d;
        const nz = dz / d;
        pa.x -= nx * push;
        pa.z -= nz * push;
        pb.x += nx * push;
        pb.z += nz * push;
      }
      const pt = this.playerTarget;
      if (!pt || pt.dead) continue;
      const dx = pa.x - pt.position.x;
      const dz = pa.z - pt.position.z;
      const min = a.radius + (pt.radius || PLAYER_RADIUS);
      const d2 = dx * dx + dz * dz;
      if (d2 >= min * min || d2 < 1e-8) continue;
      const d = Math.sqrt(d2);
      pa.x += (dx / d) * (min - d);
      pa.z += (dz / d) * (min - d);
      pushOutOfRect(pa, this.wallRect, a.radius);
    }
  }

  /**
   * Barras: só quem está ferido, brigando, ou o elite por perto; as 8 mais próximas.
   * @param {THREE.Camera} camera
   * @param {number} w
   * @param {number} h
   */
  renderBars(camera, w, h) {
    if (!this.bars) return;
    const out = this._barList;
    out.length = 0;
    for (let i = 0; i < this.targets.length; i++) {
      const e = this.targets[i];
      if (!e.root.visible || (!e.alive && !e.training)) continue;
      if (e.distPlayer > (e.elite ? ELITE_BAR_DIST : BAR_DIST)) continue;
      if (e.hp < e.maxHp || e.engaged || e.elite || (e.training && e.sinceHit < 6)) out.push(e);
    }
    out.sort(byDistance);
    this.bars.render(out, Math.min(out.length, BAR_POOL), camera, w, h);
  }
}
