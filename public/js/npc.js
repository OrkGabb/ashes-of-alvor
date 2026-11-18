import * as THREE from "three";
import { ANIM, CONFIG, dampAngle, dampFactor } from "./config.js";

// NPCs autônomos: rotinas por hora do relógio da vila (npcs.json), rota no grafo de navegação do
// city.json (Dijkstra só nas trocas de atividade), animações KayKit por intenção, figurantes com
// rotas em laço, conversas espontâneas entre NPCs parados e balões/nomes no DOM (só os próximos).

export const NPC_STATE = Object.freeze({ ACT: "ACT", WALK: "WALK", TALK: "TALKING_TO_PLAYER" });

const BLOCK_DIST = 0.8;
const PLAYER_AVOID = 1.5;      // raio em que o NPC começa a contornar o jogador
const PLAYER_ON_TARGET = 0.7;  // jogador tão perto do destino final que o NPC espera a vez
const _proj = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _yAxis = new THREE.Vector3(0, 1, 0);

export class NavGraph {
  constructor(nav) {
    this.nodes = nav.nodes;
    this.adj = {};
    for (const k of Object.keys(nav.nodes)) this.adj[k] = [];
    for (const [a, b] of nav.edges) {
      const w = Math.hypot(nav.nodes[a].x - nav.nodes[b].x, nav.nodes[a].z - nav.nodes[b].z);
      this.adj[a].push({ to: b, w });
      this.adj[b].push({ to: a, w });
    }
  }

  path(from, to) {
    if (from === to) return [to];
    const dist = { [from]: 0 };
    const prev = {};
    const open = new Set([from]);
    const closed = new Set();
    while (open.size) {
      let u = null;
      let best = Infinity;
      for (const k of open) if (dist[k] < best) { best = dist[k]; u = k; }
      if (u === to) break;
      open.delete(u);
      closed.add(u);
      for (const { to: v, w } of this.adj[u]) {
        if (closed.has(v)) continue;
        const nd = dist[u] + w;
        if (nd < (dist[v] ?? Infinity)) {
          dist[v] = nd;
          prev[v] = u;
          open.add(v);
        }
      }
    }
    if (dist[to] === undefined) return null;
    const out = [to];
    let cur = to;
    while (cur !== from) {
      cur = prev[cur];
      out.unshift(cur);
    }
    return out;
  }

  nearest(x, z) {
    let best = null;
    let bd = Infinity;
    for (const [k, n] of Object.entries(this.nodes)) {
      const d = (n.x - x) ** 2 + (n.z - z) ** 2;
      if (d < bd) { bd = d; best = k; }
    }
    return best;
  }
}

function withinHours(hour, win) {
  if (!win) return true;
  const [a, b] = win;
  return a <= b ? hour >= a && hour < b : hour >= a || hour < b;
}

function rand([a, b]) {
  return a + Math.random() * (b - a);
}

const reservations = new Map();

// Reservas de nós (assentos, postos): NPCs pulam nós reservados por outro em nextActivity. O jogador
// sentado reserva o nó de assento correspondente com o dono PLAYER_HOLDER (props.js).
export const PLAYER_HOLDER = "__player";

export function nodeHolder(key) {
  return reservations.get(key) || null;
}

export function holdNode(key, holder) {
  const owner = reservations.get(key);
  if (owner && owner !== holder) return false;
  reservations.set(key, holder);
  return true;
}

export function releaseNode(key, holder) {
  if (reservations.get(key) === holder) reservations.delete(key);
}

export class NpcAgent {
  constructor({ id, name, def, character, graph, kind, route = null, priority = 1, falas = [] }) {
    this.id = id;
    this.name = name;
    this.def = def;
    this.kind = kind;
    this.character = character;
    this.root = character.root;
    this.graph = graph;
    this.route = route;
    this.routeIdx = 0;
    this.priority = priority;
    this.falas = falas;
    this.radius = 0.32;
    this.scale = def.escala || 0.8;
    this.headHeight = 1.85 * (this.scale / 0.8);
    this.walkSpeed = (kind === "named" ? 1.35 : 1.2) * (this.scale < 0.65 ? 1.25 : 1);
    this.state = NPC_STATE.ACT;
    this.timer = 0;
    this.duration = 3;
    this.activity = null;
    this.routineIdx = -1;
    this.currentNode = null;
    this.reserved = null;
    this.path = [];
    this.pathIdx = 0;
    this.currentYaw = 0;
    this.targetYaw = 0;
    this.speed = 0;
    this.sitting = false;
    this.standingUp = 0;
    this.blocked = 0;
    this.ignoreNpcs = 0;
    this.resume = null;
    this.headTurn = 0;
    this.headBase = new THREE.Quaternion();
    this.headApplied = false;
    this.floorY = 0;
    this.social = null;
    this.bark = null;
    this.barkCooldown = 5 + Math.random() * 20;
    this.animated = true;
    this.ready = true;
  }

  get position() {
    return this.root.position;
  }

  get headY() {
    return this.root.position.y + this.headHeight * (this.sitting ? 0.72 : 1);
  }

  get statusLabel() {
    if (this.state === NPC_STATE.TALK) return "conversando com você";
    if (this.state === NPC_STATE.WALK && this.activity) return `indo: ${this.activity.label || this.activity.to}`;
    if (this.social) return `conversando com ${this.social.name}`;
    return (this.activity && this.activity.label) || "parado";
  }

  placeAt(nodeKey) {
    const n = this.graph.nodes[nodeKey];
    this.root.position.set(n.x, 0, n.z);
    this.currentNode = nodeKey;
  }

  reserve(key) {
    if (this.reserved && reservations.get(this.reserved) === this.id) reservations.delete(this.reserved);
    this.reserved = key;
    if (key) reservations.set(key, this.id);
  }

  lookAt(x, z) {
    const dx = x - this.root.position.x;
    const dz = z - this.root.position.z;
    if (dx * dx + dz * dz > 1e-4) this.targetYaw = Math.atan2(dx, dz);
  }

  // --- rotina -------------------------------------------------------------------------------
  nextActivity(hour) {
    if (this.route) {
      this.routeIdx = (this.routeIdx + 1) % this.route.length;
      const to = this.route[this.routeIdx];
      return { to, anim: Math.random() < 0.25 ? "trabalhar" : "idle", dur: [3, 9], label: "passeando pela cidade" };
    }
    const steps = this.def.rotina || [];
    for (let i = 1; i <= steps.length; i++) {
      const idx = (this.routineIdx + i) % steps.length;
      const step = steps[idx];
      if (!withinHours(hour, step.horas)) continue;
      const owner = reservations.get(step.to);
      if (owner && owner !== this.id) continue;
      this.routineIdx = idx;
      return step;
    }
    return null;
  }

  startActivity(step, instant = false) {
    this.activity = step;
    this.social = null;
    if (!step) {
      this.state = NPC_STATE.ACT;
      this.duration = 4;
      this.timer = 0;
      this.character.play(ANIM.idle);
      return;
    }
    this.reserve(this.route ? null : step.to);
    if (instant) {
      this.placeAt(step.to);
      this.arrive(true);
      return;
    }
    const from = this.currentNode || this.graph.nearest(this.root.position.x, this.root.position.z);
    const keys = this.graph.path(from, step.to);
    if (!keys) {
      this.state = NPC_STATE.ACT;
      this.duration = 3;
      this.timer = 0;
      return;
    }
    this.path = keys.map((k) => this.graph.nodes[k]);
    const p = this.root.position;
    this.pathIdx = Math.hypot(this.path[0].x - p.x, this.path[0].z - p.z) < 0.2 ? 1 : 0;
    this.currentNode = null;
    this.blocked = 0;
    if (this.sitting) {
      this.sitting = false;
      this.standingUp = this.character.duration(ANIM.sentarLevantar) * 0.8;
      this.character.play(ANIM.sentarLevantar, { once: true, fade: 0.15 });
    }
    this.state = NPC_STATE.WALK;
  }

  arrive(instant = false) {
    const step = this.activity;
    this.currentNode = step.to;
    this.path = [];
    const node = this.graph.nodes[step.to];
    if (node.look) {
      this.lookAt(node.look.x, node.look.z);
      if (instant) this.currentYaw = this.targetYaw;
    }
    this.state = NPC_STATE.ACT;
    this.timer = 0;
    this.duration = rand(step.dur || [6, 10]);
    this.playStepAnim(step, node, instant);
  }

  playStepAnim(step, node, instant) {
    const anim = step.anim || "idle";
    if (anim === "sentar" && node.seatY !== undefined) {
      this.sitting = true;
      if (instant) this.character.play(ANIM.sentar, { fade: 0 });
      else {
        this.character.play(ANIM.sentarDescer, { once: true, fade: 0.2 });
        this.pendingAnim = { name: ANIM.sentar, at: this.character.duration(ANIM.sentarDescer) * 0.92 };
      }
      return;
    }
    this.sitting = false;
    const name = ANIM[anim] || ANIM.idle;
    this.character.play(name, { fade: instant ? 0 : 0.3 });
  }

  finishActivity(hour) {
    if (this.resume) {
      const r = this.resume;
      this.resume = null;
      if (r.state === NPC_STATE.WALK && this.activity) {
        this.currentNode = this.graph.nearest(this.root.position.x, this.root.position.z);
        this.startActivity(this.activity);
        return;
      }
      if (r.remaining > 1 && this.activity) {
        this.state = NPC_STATE.ACT;
        this.timer = 0;
        this.duration = r.remaining;
        this.playStepAnim(this.activity, this.graph.nodes[this.activity.to], false);
        return;
      }
    }
    this.startActivity(this.nextActivity(hour));
  }

  // --- conversa com o jogador -----------------------------------------------------------------
  beginTalk(playerPos) {
    if (this.state === NPC_STATE.TALK) return;
    if (!this.resume) this.resume = { state: this.state, remaining: Math.max(0, this.duration - this.timer) };
    this.social = null;
    this.state = NPC_STATE.TALK;
    if (!this.sitting) {
      if (playerPos) this.lookAt(playerPos.x, playerPos.z);
      this.character.play(ANIM.idle, { fade: 0.3 });
    }
  }

  endTalk() {
    if (this.state !== NPC_STATE.TALK) return;
    this.state = NPC_STATE.ACT;
    this.timer = 0;
    this.duration = 1.2;
  }

  // --- frame ---------------------------------------------------------------------------------
  update(dt, ctx) {
    this.timer += dt;
    this.ignoreNpcs = Math.max(0, this.ignoreNpcs - dt);
    this.barkCooldown -= dt;
    let desired = 0;
    if (this.pendingAnim && this.timer >= this.pendingAnim.at) {
      this.character.play(this.pendingAnim.name, { fade: 0.15 });
      this.pendingAnim = null;
    }
    switch (this.state) {
      case NPC_STATE.ACT:
        if (this.timer >= this.duration) this.finishActivity(ctx.hour);
        else if (this.activity && this.activity.horas && !withinHours(ctx.hour, this.activity.horas) && this.timer > 5) this.finishActivity(ctx.hour);
        break;
      case NPC_STATE.WALK:
        if (this.standingUp > 0) {
          this.standingUp -= dt;
          break;
        }
        desired = this.walk(dt, ctx);
        break;
      case NPC_STATE.TALK:
        if (!this.sitting) this.lookAt(ctx.playerPos.x, ctx.playerPos.z);
        break;
    }
    this.speed += (desired - this.speed) * dampFactor(8, dt);
    if (this.state === NPC_STATE.WALK && this.standingUp <= 0) {
      if (this.speed > 0.15) this.character.play(ANIM.walk, { fade: 0.2 }).timeScale = Math.max(0.6, this.speed / 1.3);
      else this.character.play(ANIM.idle, { fade: 0.25 });
    }
    const rate = this.state === NPC_STATE.WALK ? 8 : 5;
    if (!this.sitting) this.currentYaw = dampAngle(this.currentYaw, this.targetYaw, rate, dt);
    this.root.rotation.y = this.currentYaw;
    const floor = ctx.world.zoneAt(this.root.position.x, this.root.position.z).floorY || 0;
    this.floorY += (floor - this.floorY) * dampFactor(10, dt);
    this.root.position.y = this.floorY;
    if (this.animated) {
      // Desfaz o giro de cabeça do frame anterior antes do mixer (clipes sem trilha de cabeça não acumulam)
      const head = this.character.headBone;
      if (head && this.headApplied) head.quaternion.copy(this.headBase);
      this.character.update(dt);
      this.updateHead(dt, ctx.playerPos);
    }
  }

  // A cabeça acompanha o jogador de perto (por cima da animação, limitada a ~50°)
  updateHead(dt, playerPos) {
    const head = this.character.headBone;
    if (!head) return;
    const dx = playerPos.x - this.root.position.x;
    const dz = playerPos.z - this.root.position.z;
    let target = 0;
    if (dx * dx + dz * dz < 25) {
      let diff = Math.atan2(dx, dz) - this.currentYaw;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      if (Math.abs(diff) < 1.7) target = Math.max(-0.85, Math.min(0.85, diff));
    }
    this.headTurn += (target - this.headTurn) * dampFactor(6, dt);
    this.headApplied = Math.abs(this.headTurn) > 1e-3;
    if (this.headApplied) {
      this.headBase.copy(head.quaternion);
      _q.setFromAxisAngle(_yAxis, this.headTurn);
      head.quaternion.premultiply(_q);
    }
  }

  walk(dt, ctx) {
    const target = this.path[this.pathIdx];
    if (!target) {
      this.arrive();
      return 0;
    }
    const pos = this.root.position;
    const dx = target.x - pos.x;
    const dz = target.z - pos.z;
    const dist = Math.hypot(dx, dz);
    const last = this.pathIdx === this.path.length - 1;
    if (dist <= (last ? 0.06 : 0.35)) {
      if (last) {
        pos.x = target.x;
        pos.z = target.z;
        this.arrive();
        return 0;
      }
      this.pathIdx++;
      return this.walkSpeed;
    }
    const dirX = dx / dist;
    const dirZ = dz / dist;
    // Jogador em cima do destino final (banco, balcão): espera a vez em vez de rodear o ponto
    const tpx = ctx.playerPos.x - target.x;
    const tpz = ctx.playerPos.z - target.z;
    if ((last && tpx * tpx + tpz * tpz < PLAYER_ON_TARGET * PLAYER_ON_TARGET && dist < 1.6) || this.blockedBy(ctx, dirX, dirZ)) {
      this.blocked += dt;
      if (this.blocked > 2.2) this.ignoreNpcs = 1.5;
      return 0;
    }
    this.blocked = 0;
    // Contorna o jogador em vez de parar diante dele: antes, parar sem prazo fazia todo NPC cuja rota passava
    // pelo jogador estacionar na frente dele (parado numa rua, ele virava um ímã). Desvio para o lado oposto ao
    // jogador, proporcional à proximidade, e volta à rota depois de passar.
    let mx = dirX;
    let mz = dirZ;
    const px = ctx.playerPos.x - pos.x;
    const pz = ctx.playerPos.z - pos.z;
    const pd = Math.hypot(px, pz);
    if (pd < PLAYER_AVOID && px * dirX + pz * dirZ > -0.2) {
      const side = dirX * pz - dirZ * px > 0 ? -1 : 1;
      const w = (1 - pd / PLAYER_AVOID) * 1.8;
      mx = dirX - dirZ * side * w;
      mz = dirZ + dirX * side * w;
      const ml = Math.hypot(mx, mz);
      mx /= ml;
      mz /= ml;
    }
    this.lookAt(pos.x + mx, pos.z + mz);
    const step = Math.min(dist, Math.max(this.speed, 0.2) * dt);
    pos.x += mx * step;
    pos.z += mz * step;
    return last ? this.walkSpeed * Math.min(1, dist / 0.7 + 0.25) : this.walkSpeed;
  }

  ahead(x, z, dirX, dirZ) {
    const vx = x - this.root.position.x;
    const vz = z - this.root.position.z;
    if (vx * vx + vz * vz > BLOCK_DIST * BLOCK_DIST) return false;
    return vx * dirX + vz * dirZ > 0.15;
  }

  blockedBy(ctx, dirX, dirZ) {
    if (this.ignoreNpcs > 0) return false;
    for (const o of ctx.agents) {
      if (o === this || o.priority < this.priority || (o.priority === this.priority && o.id < this.id)) continue;
      if (this.ahead(o.root.position.x, o.root.position.z, dirX, dirZ)) return true;
    }
    return false;
  }
}

// --------------------------------------------------------------------------------------------
// Rótulos e balões: um pool fixo de elementos DOM, só para os NPCs próximos
// --------------------------------------------------------------------------------------------
class LabelLayer {
  constructor(size = 8) {
    this.container = document.getElementById("npc-labels");
    this.pool = [];
    for (let i = 0; i < size; i++) {
      const el = document.createElement("div");
      el.className = "npc-label";
      el.innerHTML = '<div class="npc-bubble"></div><div class="npc-name"></div>';
      el.style.display = "none";
      this.container.appendChild(el);
      el.firstChild.style.display = "none";
      this.pool.push({ el, name: el.lastChild, bubble: el.firstChild, key: "", text: "", shown: false, x: -1, y: -1 });
    }
  }

  render(items, camera, width, height) {
    for (let i = 0; i < this.pool.length; i++) {
      const slot = this.pool[i];
      const item = items[i];
      if (!item) {
        if (slot.shown) {
          slot.el.style.display = "none";
          slot.shown = false;
        }
        continue;
      }
      _proj.set(item.agent.root.position.x, item.agent.headY + 0.35, item.agent.root.position.z).project(camera);
      if (_proj.z > 1 || _proj.z < -1) {
        if (slot.shown) {
          slot.el.style.display = "none";
          slot.shown = false;
        }
        continue;
      }
      const x = Math.round((_proj.x * 0.5 + 0.5) * width);
      const y = Math.round((-_proj.y * 0.5 + 0.5) * height);
      if (!slot.shown) {
        slot.el.style.display = "";
        slot.shown = true;
      }
      if (slot.key !== item.agent.id) {
        slot.key = item.agent.id;
        slot.name.textContent = item.agent.name;
        slot.el.dataset.kind = item.agent.kind;
        slot.el.style.setProperty("--npc-color", item.agent.def.cor || "#e6d5b8");
      }
      const text = item.bubble || "";
      if (slot.text !== text) {
        slot.text = text;
        slot.bubble.textContent = text;
        slot.bubble.style.display = text ? "" : "none";
      }
      slot.name.style.display = item.showName ? "" : "none";
      if (slot.x !== x || slot.y !== y) {
        slot.x = x;
        slot.y = y;
        slot.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
      }
    }
  }
}

export class NpcSystem {
  constructor(factory) {
    this.factory = factory;
    this.agents = [];
    this.ctx = { playerPos: null, agents: this.agents, world: null, hour: 0 };
    this.labels = null;
    this.socialTimer = 0;
    this.labelItems = [];
  }

  async init(world, scene, data, hour) {
    this.world = world;
    this.ctx.world = world;
    this.graph = new NavGraph(world.nav);
    this.labels = new LabelLayer(8);
    const named = Object.entries(data.npcs);
    const types = Object.fromEntries(data.figurantes.tipos.map((t) => [t.id, t]));
    await this.factory.preload([...named.map(([, d]) => d.modelo), ...data.figurantes.tipos.map((t) => t.modelo)]);
    for (const [id, def] of named) {
      const character = await this.factory.create({ model: def.modelo, scale: def.escala, scaleWidth: def.escala_largura || 1, recolor: def.recolor, hide: def.ocultar });
      const agent = new NpcAgent({ id, name: def.nome, def, character, graph: this.graph, kind: "named", priority: 2, falas: def.falas || [] });
      scene.add(agent.root);
      this.agents.push(agent);
    }
    data.figurantes.rotas.forEach((rota, k) => {
      const t = types[rota.tipo];
      this.agents.push({ pending: true, t, rota, k });
    });
    for (let i = 0; i < this.agents.length; i++) {
      const p = this.agents[i];
      if (!p.pending) continue;
      const character = await this.factory.create({ model: p.t.modelo, scale: p.t.escala, recolor: p.t.recolor, hide: p.t.ocultar });
      const agent = new NpcAgent({ id: `fig_${p.k}`, name: p.t.nome, def: p.t, character, graph: this.graph, kind: "figurante", route: p.rota.pontos, priority: 1, falas: p.t.falas });
      agent.routeIdx = Math.floor(Math.random() * p.rota.pontos.length);
      scene.add(agent.root);
      this.agents[i] = agent;
    }
    // Todo mundo começa já na atividade do horário (nada de multidão saindo de casa no primeiro frame)
    for (const a of this.agents) {
      const step = a.nextActivity(hour);
      if (step) a.startActivity(step, true);
      else a.placeAt(a.def.casa || this.graph.nearest(0, 0));
      a.timer = Math.random() * a.duration * 0.7;
    }
  }

  byId(id) {
    for (const a of this.agents) if (a.id === id) return a;
    return null;
  }

  nearest(pos, maxDist, filter = null) {
    let best = null;
    let bd = maxDist;
    for (const a of this.agents) {
      if (filter && !filter(a)) continue;
      const d = Math.hypot(a.root.position.x - pos.x, a.root.position.z - pos.z);
      if (d <= bd) { bd = d; best = a; }
    }
    return best;
  }

  presentNear(pos, radius) {
    return this.agents.filter((a) => a.kind === "named" && Math.hypot(a.root.position.x - pos.x, a.root.position.z - pos.z) <= radius);
  }

  // Conversas espontâneas: dois NPCs parados a menos de 2,4 m se viram um para o outro e trocam falas
  updateSocial(dt) {
    this.socialTimer += dt;
    if (this.socialTimer < 1.0) return;
    this.socialTimer = 0;
    const idle = this.agents.filter((a) => a.state === NPC_STATE.ACT && !a.sitting && a.animated);
    for (const a of idle) {
      if (a.social) {
        if (Math.hypot(a.social.root.position.x - a.root.position.x, a.social.root.position.z - a.root.position.z) > 3 || a.social.state !== NPC_STATE.ACT) a.social = null;
        continue;
      }
      for (const b of idle) {
        if (b === a || b.social) continue;
        if (Math.hypot(b.root.position.x - a.root.position.x, b.root.position.z - a.root.position.z) < 2.4) {
          a.social = b;
          b.social = a;
          a.lookAt(b.root.position.x, b.root.position.z);
          b.lookAt(a.root.position.x, a.root.position.z);
          break;
        }
      }
    }
  }

  update(dt, elapsed, playerPos, camera, hour) {
    this.ctx.playerPos = playerPos;
    this.ctx.hour = hour;
    const cam = camera.position;
    const animDist2 = CONFIG.npc.animDistance ** 2;
    for (const a of this.agents) {
      const d2 = (a.root.position.x - cam.x) ** 2 + (a.root.position.z - cam.z) ** 2;
      a.animated = d2 < animDist2;
      a.root.visible = d2 < animDist2 * 1.6;
      a.update(dt, this.ctx);
    }
    this.updateSocial(dt);
  }

  // Balões (falas curtas, sem narrador) e nomes; até 8 rótulos, ordenados por distância
  updateLabels(dt, playerPos, camera, width, height, talkingTo) {
    const items = this.labelItems;
    items.length = 0;
    const lab2 = CONFIG.npc.labelDistance ** 2;
    for (const a of this.agents) {
      const d2 = (a.root.position.x - playerPos.x) ** 2 + (a.root.position.z - playerPos.z) ** 2;
      if (a.bark) {
        a.bark.t -= dt;
        if (a.bark.t <= 0) a.bark = null;
      }
      if (d2 > lab2 || !a.root.visible || a === talkingTo) continue;
      if (!a.bark && a.barkCooldown <= 0 && a.falas.length && d2 < CONFIG.npc.barkDistance ** 2 && a.state !== NPC_STATE.TALK) {
        a.bark = { text: a.falas[Math.floor(Math.random() * a.falas.length)], t: 4.5 };
        a.barkCooldown = CONFIG.npc.barkCooldown + Math.random() * 15;
      } else if (!a.bark && a.social && a.barkCooldown <= 0 && a.falas.length && Math.random() < 0.02) {
        a.bark = { text: a.falas[Math.floor(Math.random() * a.falas.length)], t: 4 };
        a.barkCooldown = CONFIG.npc.barkCooldown;
      }
      items.push({ agent: a, d2, bubble: a.bark ? a.bark.text : "", showName: a.kind === "named" || d2 < 9 });
    }
    items.sort((x, y) => x.d2 - y.d2);
    if (items.length > 8) items.length = 8;
    this.labels.render(items, camera, width, height);
  }
}
