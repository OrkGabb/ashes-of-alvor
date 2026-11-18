import { ANIM, CONFIG } from "./config.js";
import { setHingeAngle } from "./world.js";
import { NPC_STATE, PLAYER_HOLDER, holdNode, nodeHolder, releaseNode } from "./npc.js";

// Interatividade do mundo: peças articuladas (portas, portão do castelo, baús), janelas das
// fachadas, assentos, fontes, sino, alavancas, placas e lareiras. Tudo vem do city.json; os
// ajustes ficam em CONFIG.props. Um único update(dt) por frame, sem closures nem alocação nele.
// Tipos de interativo do city.json entram por PropSystem.defineKinds() no InteractableRegistry.

function ease(t) {
  return t * t * (3 - 2 * t);
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function rand(range) {
  return range[0] + Math.random() * (range[1] - range[0]);
}

function stripPrefix(key, prefix) {
  return typeof key === "string" && key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

function point(p, y = 1.2) {
  return { x: p[0], y: (p[1] || 0) + y, z: p[2] };
}

// --------------------------------------------------------------------------------------------
// Peças articuladas: anima a fração de abertura (0 fechado, 1 = hinge.angle) com easing
// --------------------------------------------------------------------------------------------
export class HingeSystem {
  constructor(hinges) {
    this.items = hinges || new Map();
    this.active = [];
    for (const h of this.items.values()) {
      h.fraction = h.open ? 1 : 0;
      h.from = h.fraction;
      h.to = h.fraction;
      h.t = 0;
      h.span = 0;
      h.moving = false;
    }
  }

  get(key) {
    return this.items.get(key) || null;
  }

  // Leva a peça até 'fraction'; a duração é proporcional ao trecho a percorrer
  set(key, fraction, instant = false) {
    const h = this.items.get(key);
    if (!h) return null;
    if (instant) {
      h.fraction = fraction;
      h.from = fraction;
      h.to = fraction;
      setHingeAngle(h, h.angle * fraction);
      return h;
    }
    if (h.to === fraction && (h.moving || h.fraction === fraction)) return h;
    h.from = h.fraction;
    h.to = fraction;
    h.t = 0;
    h.span = Math.max(0.12, h.dur * Math.abs(fraction - h.fraction));
    if (!h.moving) {
      h.moving = true;
      this.active.push(h);
    }
    return h;
  }

  update(dt) {
    const list = this.active;
    for (let i = list.length - 1; i >= 0; i--) {
      const h = list[i];
      h.t += dt;
      const f = Math.min(1, h.t / h.span);
      h.fraction = h.from + (h.to - h.from) * ease(f);
      setHingeAngle(h, h.angle * h.fraction);
      if (f >= 1) {
        h.moving = false;
        list[i] = list[list.length - 1];
        list.pop();
      }
    }
  }
}

// --------------------------------------------------------------------------------------------
// Portas: E abre/fecha as que dão para interior real; nas trancadas, bate e alguém (talvez) responde
// --------------------------------------------------------------------------------------------
const KNOCK_CRACK = 1;
const KNOCK_VOICE = 2;
const KNOCK_SILENCE = 3;

export class DoorSystem {
  constructor(ctx, hinges) {
    this.ctx = ctx;
    this.hinges = hinges;
    this.list = [];
    this.byId = new Map();
    this.npcTimer = 0;
    const city = ctx.world.city;
    for (const spec of city.doors || []) {
      const inst = city.instances[spec.inst];
      const hingeKey = inst && inst.hinge ? inst.hinge.key : spec.id;
      const door = {
        id: spec.id,
        spec,
        hingeKey,
        hinge: hinges.get(hingeKey),
        colliders: [],
        x: spec.p[0],
        z: spec.p[2],
        pos: point(spec.p, 1.1),
        wanted: Boolean(spec.open),
        auto: false,
        lastNear: -Infinity,
        knock: 0,
        knockT: 0,
        knockText: "",
        crackT: 0,
        cooldownUntil: 0,
      };
      this.list.push(door);
      this.byId.set(door.id, door);
    }
    for (const c of ctx.world.colliders) {
      if (!c.door) continue;
      const d = this.byId.get(c.door);
      if (d) d.colliders.push(c);
    }
    for (const d of this.list) {
      hinges.set(d.hingeKey, d.wanted ? 1 : 0, true);
      this.syncColliders(d);
    }
  }

  get(id) {
    return this.byId.get(id) || null;
  }

  fraction(d) {
    return d.hinge ? d.hinge.fraction : d.wanted ? 1 : 0;
  }

  syncColliders(d) {
    if (!d.colliders.length) return;
    const off = this.fraction(d) >= CONFIG.props.door.colliderOffAt;
    for (let i = 0; i < d.colliders.length; i++) d.colliders[i].off = off;
  }

  notifyInteriors(d, open) {
    const it = this.ctx.world.interiors;
    if (it && typeof it.setDoorOpen === "function") it.setDoorOpen(d.id, open);
  }

  setOpen(d, open, fraction = open ? 1 : 0) {
    const was = d.wanted;
    d.wanted = open;
    this.hinges.set(d.hingeKey, fraction);
    if (was !== open) {
      this.ctx.audio.fx(open ? "doorOpen" : "doorClose", d.pos);
      this.notifyInteriors(d, open);
    }
  }

  // Ação do jogador (E): portas de interior abrem/fecham; trancadas recebem batidas
  use(d) {
    if (d.spec.enterable && !d.spec.locked) {
      d.auto = false;
      this.setOpen(d, !d.wanted);
      return true;
    }
    return this.knock(d);
  }

  toggle(id) {
    const d = this.byId.get(id);
    if (!d) return null;
    d.auto = false;
    this.setOpen(d, !d.wanted);
    return d.wanted;
  }

  knock(d) {
    const ctx = this.ctx;
    const k = CONFIG.props.knock;
    if (ctx.time < d.cooldownUntil || d.knock) return false;
    d.cooldownUntil = ctx.time + k.cooldown;
    ctx.audio.fx("knock", d.pos);
    ctx.player.gesture(ANIM.trabalhar);
    const night = ctx.atmosphere.state.night > 0.5;
    const b = CONFIG.props.batidas;
    const r = Math.random();
    const openChance = night ? k.openChanceNight : k.openChanceDay;
    const voiceChance = night ? k.answerChanceNight : k.answerChanceDay;
    if (r < openChance) {
      d.knock = KNOCK_CRACK;
      d.knockText = pick(night ? b.frestaNoite : b.fresta);
    } else if (r < openChance + voiceChance) {
      d.knock = KNOCK_VOICE;
      d.knockText = pick(night ? b.fechadaNoite : b.fechada);
    } else {
      d.knock = KNOCK_SILENCE;
      d.knockText = pick(b.silencio);
    }
    d.knockT = rand(k.delay);
    return true;
  }

  resolveKnock(d) {
    const ctx = this.ctx;
    const k = CONFIG.props.knock;
    if (d.knock === KNOCK_CRACK) {
      this.setOpen(d, true, k.crackFraction);
      d.crackT = rand(k.crackHold);
      ctx.hud.toast(`${k.voicePrefix}«${d.knockText}»`);
    } else if (d.knock === KNOCK_VOICE) {
      ctx.hud.toast(`${k.voicePrefix}«${d.knockText}»`);
    } else {
      ctx.hud.toast(d.knockText, "warn");
    }
    d.knock = 0;
  }

  // Algum NPC andando (seguindo a rota pelo vão) a 'radius' metros da porta? Parados não contam:
  // um morador conversando ao lado da porta não deve mantê-la aberta contra o jogador
  someoneNear(d, radius) {
    const r2 = radius * radius;
    const agents = this.ctx.npcs.agents;
    for (let i = 0; i < agents.length; i++) {
      if (agents[i].state !== NPC_STATE.WALK) continue;
      const p = agents[i].root.position;
      if ((p.x - d.x) ** 2 + (p.z - d.z) ** 2 < r2) return true;
    }
    return false;
  }

  playerNear(d, radius) {
    const p = this.ctx.player.position;
    return (p.x - d.x) ** 2 + (p.z - d.z) ** 2 < radius * radius;
  }

  // NPCs seguem as arestas pelos vãos: a porta abre sozinha e volta a fechar depois que todos
  // saíram, mas só se foi aberta por eles (nunca fecha o que o jogador abriu)
  updateNpcDoors() {
    const conf = CONFIG.props.door;
    const now = this.ctx.time;
    for (let i = 0; i < this.list.length; i++) {
      const d = this.list[i];
      if (!d.spec.enterable || d.spec.locked) continue;
      const near = this.someoneNear(d, conf.npcRadius);
      if (near) {
        d.lastNear = now;
        if (!d.wanted) {
          d.auto = true;
          this.setOpen(d, true);
        }
      } else if (d.auto && d.wanted && now - d.lastNear > conf.autoCloseDelay && !this.playerNear(d, conf.npcRadius)) {
        d.auto = false;
        this.setOpen(d, false);
      }
    }
  }

  update(dt) {
    for (let i = 0; i < this.list.length; i++) {
      const d = this.list[i];
      if (d.knock) {
        d.knockT -= dt;
        if (d.knockT <= 0) this.resolveKnock(d);
      }
      if (d.crackT > 0) {
        d.crackT -= dt;
        if (d.crackT <= 0) this.setOpen(d, false);
      }
      this.syncColliders(d);
    }
    this.npcTimer += dt;
    if (this.npcTimer >= CONFIG.props.door.npcCheckEvery) {
      this.npcTimer = 0;
      this.updateNpcDoors();
    }
  }

  interactable(d) {
    const conf = CONFIG.props.door;
    const sys = this;
    const knocks = !d.spec.enterable || d.spec.locked;
    return {
      id: `door:${d.id}`,
      priority: conf.priority,
      reach: conf.reach,
      label: () => (knocks ? conf.labelKnock : d.wanted ? conf.labelClose : conf.labelOpen),
      muted: () => knocks && (sys.ctx.time < d.cooldownUntil || d.knock !== 0),
      enabled: () => !sys.ctx.player.seat,
      distance: (pos) => Math.hypot(d.x - pos.x, d.z - pos.z),
      interact: () => sys.use(d),
    };
  }

  snapshot() {
    return this.list.map((d) => ({
      id: d.id,
      open: d.wanted,
      fraction: +this.fraction(d).toFixed(3),
      enterable: Boolean(d.spec.enterable),
      locked: Boolean(d.spec.locked),
      leaf: Boolean(d.hinge && (d.hinge.entries.length || d.hinge.nodes.length)),
      blocking: d.colliders.length ? !d.colliders[0].off : null,
      auto: d.auto,
    }));
  }
}

// --------------------------------------------------------------------------------------------
// Portões (city.gates): uma peça articulada + colisores 'gate' que só barram com ele fechado
// --------------------------------------------------------------------------------------------
export class GateSystem {
  constructor(ctx, hinges) {
    this.ctx = ctx;
    this.hinges = hinges;
    this.byKey = new Map();
    this.list = [];
    for (const spec of ctx.world.city.gates || []) {
      const g = { key: spec.key, spec, hingeKey: spec.hinge, hinge: hinges.get(spec.hinge), open: Boolean(spec.open), colliders: [] };
      g.pos = g.hinge ? g.hinge.center : null;
      this.list.push(g);
      this.byKey.set(g.key, g);
    }
    for (const c of ctx.world.colliders) {
      if (!c.gate) continue;
      const g = this.byKey.get(stripPrefix(c.gate, "gate:"));
      if (g) g.colliders.push(c);
    }
    for (const g of this.list) {
      hinges.set(g.hingeKey, g.open ? 1 : 0, true);
      this.syncColliders(g);
    }
  }

  get(key) {
    return this.byKey.get(stripPrefix(key, "gate:")) || null;
  }

  syncColliders(g) {
    if (!g.colliders.length) return;
    const f = g.hinge ? g.hinge.fraction : g.open ? 1 : 0;
    const off = f >= CONFIG.props.gate.colliderOffAt;
    for (let i = 0; i < g.colliders.length; i++) g.colliders[i].off = off;
  }

  toggle(key) {
    const g = this.get(key);
    if (!g) return null;
    g.open = !g.open;
    this.hinges.set(g.hingeKey, g.open ? 1 : 0);
    this.ctx.audio.fx("gate", g.pos);
    return g.open;
  }

  update() {
    for (let i = 0; i < this.list.length; i++) this.syncColliders(this.list[i]);
  }

  snapshot() {
    return this.list.map((g) => ({ key: g.key, open: g.open, fraction: g.hinge ? +g.hinge.fraction.toFixed(3) : null, blocking: g.colliders.length ? !g.colliders[0].off : null }));
  }
}

// --------------------------------------------------------------------------------------------
// Janelas do térreo de prédios sem interior real: abrir/fechar conversa com world.interiors
// --------------------------------------------------------------------------------------------
export class WindowToggles {
  constructor(ctx) {
    this.ctx = ctx;
    this.list = [];
    this.byId = new Map();
    for (const w of ctx.world.city.windows || []) {
      if (w.floor !== 0 || w.real) continue;
      const item = { id: w.id, spec: w, x: w.p[0], z: w.p[2], outX: Math.cos(w.r), outZ: -Math.sin(w.r), open: Boolean(w.open), pos: { x: w.p[0], y: w.p[1], z: w.p[2] } };
      this.list.push(item);
      this.byId.set(item.id, item);
    }
    this.best = null;
  }

  isOpen(w) {
    const it = this.ctx.world.interiors;
    if (it && typeof it.isWindowOpen === "function") {
      const v = it.isWindowOpen(w.id);
      if (typeof v === "boolean") return v;
    }
    return w.open;
  }

  setOpen(id, open) {
    const w = this.byId.get(id);
    if (!w) return null;
    w.open = open;
    const it = this.ctx.world.interiors;
    if (it && typeof it.setWindowOpen === "function") it.setWindowOpen(w.id, open);
    this.ctx.audio.fx("window", w.pos);
    return open;
  }

  toggle(w) {
    this.ctx.player.gesture(ANIM.trabalhar);
    return this.setOpen(w.id, !this.isOpen(w));
  }

  // Janela mais próxima que o jogador encara, do lado de fora, dentro do alcance (ou nenhuma)
  findBest(pos) {
    const conf = CONFIG.props.window;
    const yaw = this.ctx.player.yaw;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const r2 = conf.reach * conf.reach;
    let best = null;
    let bd = r2;
    for (let i = 0; i < this.list.length; i++) {
      const w = this.list[i];
      const dx = pos.x - w.x;
      const dz = pos.z - w.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= bd) continue;
      if (dx * w.outX + dz * w.outZ <= 0) continue;
      if (-(fx * w.outX + fz * w.outZ) < conf.facingDot) continue;
      bd = d2;
      best = w;
    }
    this.best = best;
    return best ? Math.sqrt(bd) : Infinity;
  }

  interactable() {
    const conf = CONFIG.props.window;
    const sys = this;
    return {
      get id() {
        return sys.best ? `window:${sys.best.id}` : "window";
      },
      priority: 0,
      reach: conf.reach,
      label: () => (sys.best && sys.isOpen(sys.best) ? conf.labelClose : conf.labelOpen),
      muted: () => false,
      enabled: () => sys.list.length > 0 && !sys.ctx.player.seat,
      distance: (pos) => sys.findBest(pos),
      interact: () => sys.best && sys.toggle(sys.best),
    };
  }
}

// --------------------------------------------------------------------------------------------
// Assentos: o jogador senta onde um NPC não esteja (reserva o nó de assento correspondente)
// --------------------------------------------------------------------------------------------
export class SeatSystem {
  constructor(ctx) {
    this.ctx = ctx;
    this.byKey = new Map();
    this.current = null;
  }

  add(spec) {
    const look = spec.look || [spec.p[0], spec.p[2] - 1];
    const seat = { key: spec.key, spec, x: spec.p[0], z: spec.p[2], lookX: look[0], lookZ: look[1], node: this.matchNode(spec.p[0], spec.p[2]), pos: point(spec.p, 0.4) };
    this.byKey.set(seat.key, seat);
    return seat;
  }

  matchNode(x, z) {
    const nodes = this.ctx.world.nav ? this.ctx.world.nav.nodes : null;
    if (!nodes) return null;
    const r = CONFIG.props.seat.npcNodeRadius;
    let best = null;
    let bd = r * r;
    for (const [k, n] of Object.entries(nodes)) {
      if (n.seatY === undefined) continue;
      const d2 = (n.x - x) ** 2 + (n.z - z) ** 2;
      if (d2 <= bd) {
        bd = d2;
        best = k;
      }
    }
    return best;
  }

  get playerSeated() {
    return this.current !== null && this.ctx.player.seated;
  }

  occupied(seat) {
    if (this.current === seat) return false;
    if (this.current === null && this.ctx.player.seat) return true;
    if (seat.node) {
      const holder = nodeHolder(seat.node);
      if (holder && holder !== PLAYER_HOLDER) return true;
    }
    const r2 = CONFIG.props.seat.npcNodeRadius ** 2;
    const agents = this.ctx.npcs.agents;
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (!a.sitting) continue;
      const p = a.root.position;
      if ((p.x - seat.x) ** 2 + (p.z - seat.z) ** 2 < r2) return true;
    }
    return false;
  }

  sit(seat) {
    const ctx = this.ctx;
    if (!seat || ctx.player.seat || this.occupied(seat)) return false;
    if (seat.node && !holdNode(seat.node, PLAYER_HOLDER)) return false;
    if (!ctx.player.sitAt(seat.x, seat.z, seat.lookX, seat.lookZ)) {
      if (seat.node) releaseNode(seat.node, PLAYER_HOLDER);
      return false;
    }
    this.current = seat;
    ctx.audio.fx("sit", seat.pos);
    return true;
  }

  stand() {
    if (!this.current) return false;
    this.ctx.player.standUp();
    return true;
  }

  use(seat) {
    if (this.current === seat) return this.stand();
    return this.sit(seat);
  }

  // O jogador pode levantar sozinho (WASD): libera a reserva quando ele termina de levantar
  update() {
    const cur = this.current;
    if (cur && !this.ctx.player.seat) {
      if (cur.node) releaseNode(cur.node, PLAYER_HOLDER);
      this.current = null;
    }
  }

  interactable(seat) {
    const conf = CONFIG.props.seat;
    const sys = this;
    return {
      id: `seat:${seat.key}`,
      get priority() {
        return sys.current === seat ? 9 : conf.priority;
      },
      reach: seat.spec.reach || conf.reach,
      label: () => (sys.current === seat ? conf.labelStand : sys.occupied(seat) ? conf.labelBusy : seat.spec.label),
      muted: () => sys.current !== seat && sys.occupied(seat),
      enabled: () => sys.current === seat || !sys.ctx.player.seat,
      distance: (pos) => Math.hypot(seat.x - pos.x, seat.z - pos.z),
      interact: () => sys.use(seat),
    };
  }
}

// --------------------------------------------------------------------------------------------
// Fachada única: monta os subsistemas, define os tipos de interativo e roda o update do frame
// --------------------------------------------------------------------------------------------
export class PropSystem {
  constructor({ world, player, npcs, stats, audio, hud, atmosphere, signWindow, onCollect, canCollect, onVisit }) {
    this.ctx = { world, player, npcs, stats, audio, hud, atmosphere, signWindow, onCollect, canCollect, onVisit, time: 0 };
    this.hinges = new HingeSystem(world.hinges);
    this.doors = new DoorSystem(this.ctx, this.hinges);
    this.gates = new GateSystem(this.ctx, this.hinges);
    this.windows = new WindowToggles(this.ctx);
    this.seats = new SeatSystem(this.ctx);
    this.chests = new Map();
  }

  get seated() {
    return this.seats.playerSeated;
  }

  // Interativos que não vêm de city.interactables (portas e janelas)
  registerFixed(interactions) {
    for (const d of this.doors.list) interactions.register(this.doors.interactable(d));
    if (this.windows.list.length) interactions.register(this.windows.interactable());
  }

  // Tipos de city.interactables tratados aqui (aberto para extensão: novo tipo = novo define)
  defineKinds(registry) {
    registry
      .define("seat", (spec) => this.seats.interactable(this.seats.add(spec)))
      .define("drink", (spec) => this.timedUse(spec, CONFIG.props.drink, this.drink))
      .define("bell", (spec) => this.timedUse(spec, CONFIG.props.bell, this.ringBell))
      .define("hearth", (spec) => this.timedUse(spec, CONFIG.props.hearth, this.warmHands))
      .define("shrine", (spec) => this.timedUse(spec, { priority: 2, reach: 2.0, cooldown: 15, labelCooldown: "A energia do santuário se recompõe..." }, this.useShrine))
      .define("lever", (spec) => this.leverInteractable(spec))
      .define("chest", (spec) => this.chestInteractable(spec))
      .define("sign", (spec) => this.signInteractable(spec))
      .define("vista", (spec) => this.vistaInteractable(spec));
    return registry;
  }

  // Interativo com recarga (fonte, sino, lareira): 'action' recebe (spec, pos) com this = PropSystem
  timedUse(spec, conf, action) {
    const ctx = this.ctx;
    const state = { until: 0 };
    const pos = point(spec.p, 1.0);
    return {
      id: `${spec.kind}:${spec.key}`,
      priority: conf.priority,
      reach: spec.reach || conf.reach,
      label: () => (ctx.time < state.until && conf.labelCooldown ? conf.labelCooldown : spec.label),
      muted: () => ctx.time < state.until,
      enabled: () => !ctx.player.seat,
      distance: (p) => Math.hypot(spec.p[0] - p.x, spec.p[2] - p.z),
      interact: () => {
        if (ctx.time < state.until) return false;
        state.until = ctx.time + (spec.cooldown || conf.cooldown);
        action.call(this, spec, pos);
        return true;
      },
    };
  }

  drink(spec, pos) {
    const ctx = this.ctx;
    const r = spec.restore || CONFIG.props.drink.restore;
    ctx.player.gesture(ANIM.pegar);
    ctx.audio.fx("water", pos);
    ctx.stats.apply({ vigor: Number(r.vigor || 0), calor: Number(r.calor || 0) });
    ctx.hud.toast(CONFIG.props.drink.toast, "success");
  }

  ringBell(spec, pos) {
    const ctx = this.ctx;
    ctx.player.gesture(ANIM.trabalhar);
    ctx.audio.fx("bell", pos, 0.8);
    const r2 = CONFIG.props.bell.npcRadius ** 2;
    const agents = ctx.npcs.agents;
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (a.state === NPC_STATE.TALK || a.sitting) continue;
      const p = a.root.position;
      if ((p.x - pos.x) ** 2 + (p.z - pos.z) ** 2 < r2) a.lookAt(pos.x, pos.z);
    }
    ctx.hud.toast(CONFIG.props.bell.toast);
  }

  warmHands(spec, pos) {
    const ctx = this.ctx;
    ctx.player.gesture(ANIM.trabalhar);
    ctx.audio.fx("warm", pos);
    ctx.stats.apply({ calor: spec.calor || CONFIG.props.hearth.calor });
    ctx.hud.toast(CONFIG.props.hearth.toast, "success");
  }

  useShrine(spec, pos) {
    const ctx = this.ctx;
    ctx.player.gesture(ANIM.trabalhar);
    ctx.audio.fx("warm", pos);
    const r = spec.restore || { vigor: 50, calor: 60 };
    ctx.stats.apply({ vigor: Number(r.vigor || 0), calor: Number(r.calor || 0) });
    ctx.hud.toast("A luz ancestral do santuário renova seu calor e fôlego.", "success");
    if (spec.marco && ctx.onVisit) ctx.onVisit(spec.marco);
  }

  leverInteractable(spec) {
    const ctx = this.ctx;
    const conf = CONFIG.props.gate;
    const gates = this.gates;
    const pos = point(spec.p, 1.0);
    return {
      id: `lever:${spec.key}`,
      priority: conf.priority,
      reach: spec.reach || conf.reach,
      label: () => {
        const g = gates.get(spec.gate);
        if (!g) return spec.label;
        // Rótulo do layout vale nos dois sentidos ("Girar o sarilho..."); CONFIG só como reserva
        return g.open ? spec.labelClose || spec.label || conf.labelClose : spec.labelOpen || spec.label || conf.labelOpen;
      },
      muted: () => {
        const g = gates.get(spec.gate);
        return !g || Boolean(g.hinge && g.hinge.moving);
      },
      enabled: () => !ctx.player.seat,
      distance: (p) => Math.hypot(spec.p[0] - p.x, spec.p[2] - p.z),
      interact: () => {
        const g = gates.get(spec.gate);
        if (!g || (g.hinge && g.hinge.moving)) return false;
        ctx.player.gesture(ANIM.trabalhar);
        ctx.audio.fx("lever", pos);
        gates.toggle(g.key);
        return true;
      },
    };
  }

  chestInteractable(spec) {
    const ctx = this.ctx;
    const conf = CONFIG.props.chest;
    const hinges = this.hinges;
    const state = { open: false, looked: false };
    this.chests.set(spec.key, state);
    const pos = point(spec.p, 0.6);
    return {
      id: `chest:${spec.key}`,
      priority: conf.priority,
      reach: spec.reach || conf.reach,
      label: () => (state.open ? conf.labelClose : spec.label || conf.labelOpen),
      muted: () => !hinges.get(spec.hinge),
      enabled: () => !ctx.player.seat,
      distance: (p) => Math.hypot(spec.p[0] - p.x, spec.p[2] - p.z),
      interact: () => {
        if (!hinges.get(spec.hinge)) return false;
        state.open = !state.open;
        hinges.set(spec.hinge, state.open ? 1 : 0);
        ctx.audio.fx("chest", pos);
        if (state.open) {
          ctx.player.gesture(ANIM.trabalhar);
          if (spec.loot && ctx.onCollect) {
            if (!ctx.canCollect || ctx.canCollect(spec.loot)) {
              ctx.onCollect(spec.loot);
            } else if (!state.looked) {
              ctx.hud.toast(spec.empty || conf.emptyToast);
            }
          } else if (!state.looked) {
            ctx.hud.toast(spec.empty || conf.emptyToast);
          }
          state.looked = true;
        }
        return true;
      },
    };
  }

  signInteractable(spec) {
    const ctx = this.ctx;
    const conf = CONFIG.props.sign;
    return {
      id: `sign:${spec.key}`,
      priority: conf.priority,
      reach: spec.reach || conf.reach,
      label: () => spec.label,
      muted: () => false,
      enabled: () => Boolean(ctx.signWindow),
      distance: (p) => Math.hypot(spec.p[0] - p.x, spec.p[2] - p.z),
      interact: () => ctx.signWindow.show(spec),
    };
  }

  vistaInteractable(spec) {
    const ctx = this.ctx;
    return {
      id: `vista:${spec.key}`,
      priority: 2,
      reach: spec.reach || 2.0,
      label: () => spec.label,
      muted: () => false,
      enabled: () => Boolean(ctx.signWindow),
      distance: (p) => Math.hypot(spec.p[0] - p.x, spec.p[2] - p.z),
      interact: () => {
        ctx.signWindow.show(spec);
        ctx.audio.fx("pagina");
        if (spec.marco && ctx.onVisit) ctx.onVisit(spec.marco);
        return true;
      },
    };
  }

  update(dt) {
    this.ctx.time += dt;
    this.hinges.update(dt);
    this.doors.update(dt);
    this.gates.update();
    this.seats.update();
  }
}
