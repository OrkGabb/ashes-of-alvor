import { CONFIG } from "./config.js";

// Estado de jogo do cliente: espelho do estado autoritativo do servidor (jogo.EstadoJogo).
// Toda mudança de bolsa, carteira, missão, equipamento e abates passa pelo servidor; o cliente só
// simula o corpo (vida, mana, vigor e calor) em tempo real e sincroniza o retrato de tempos em tempos.

export class GameState extends EventTarget {
  /** @param {{items: object, quests: object, npcs: object}} data */
  constructor(data) {
    super();
    this.items = data.items.itens;
    this.coin = data.items.moeda;
    this.statusDef = data.items.status;
    this.quests = data.quests.missoes;
    this.collectibleDefs = data.quests.coletaveis;
    this.npcs = data.npcs.npcs;
    this.server = null;
    this.cobre = 0;
    this.itens = {};
    this.missoes = {};
    this.disponiveis = {};
    this.coletados = new Set();
    this.marcos = new Set();
    this.confianca = {};
    this.tarefa = "";
    this.pendingMarcos = new Set();
    /** @type {{arma?: string}} espelho de state.equipado */
    this.equipado = {};
    /** @type {Record<string, number>} espelho de state.abates (tipo de inimigo -> total) */
    this.abates = {};
  }

  /** @param {object|null|undefined} state */
  applyServerState(state) {
    if (!state) return;
    const prev = { itens: { ...this.itens }, cobre: this.cobre };
    this.server = state;
    this.cobre = state.cobre ?? this.cobre;
    this.itens = state.itens || {};
    this.missoes = state.missoes || {};
    this.disponiveis = state.missoes_disponiveis || {};
    this.coletados = new Set(state.coletados || []);
    this.marcos = new Set(state.marcos || []);
    this.confianca = state.confianca_npc || {};
    this.tarefa = state.tarefa || "";
    this.equipado = state.equipado || {};
    this.abates = state.abates || {};
    this.dispatchEvent(new CustomEvent("change", { detail: { prev, state } }));
  }

  /** @param {string} item @returns {number} */
  qty(item) {
    return this.itens[item] || 0;
  }

  get temLenha() {
    return this.qty("feixe_lenha") > 0;
  }

  activeQuests() {
    return Object.entries(this.missoes).filter(([, m]) => m.estado === "ativa");
  }

  // Missões cuja etapa atual se resolve com este NPC (entregar, pagar ou falar)
  turnInsFor(npc) {
    return this.activeQuests().filter(([, m]) => m.objetivo && m.objetivo.npc === npc && ["entregar", "pagar", "falar"].includes(m.objetivo.tipo));
  }

  offersFor(npc) {
    return this.disponiveis[npc] || [];
  }

  collectibleState(key) {
    const def = this.collectibleDefs[key];
    if (!def || this.coletados.has(key)) return { exists: false, eligible: false, def };
    if (!def.missao) return { exists: true, eligible: true, def };
    const m = this.missoes[def.missao];
    const q = this.quests[def.missao];
    const etapa = m && m.estado === "ativa" ? q.etapas[m.etapa] : null;
    return { exists: true, eligible: Boolean(etapa && etapa.id === def.etapa), def };
  }

  /** Definição da arma equipada (items.json) ou null. @returns {object|null} */
  get weaponDef() {
    const id = this.equipado.arma;
    return id && this.items[id] ? this.items[id] : null;
  }

  /**
   * @param {string} acao
   * @param {object} [body]
   * @returns {Promise<object>}
   */
  async action(acao, body = {}) {
    try {
      const res = await fetch("/api/acao", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acao, ...body }),
      });
      const data = await res.json();
      if (data.state) this.applyServerState(data.state);
      return data;
    } catch (err) {
      console.warn("[Alvor] /api/acao indisponível:", err);
      return { ok: false, message: "Servidor indisponível." };
    }
  }

  // Marcos são registrados uma vez (o servidor ignora repetidos e avança a missão do mapa sozinho)
  async visit(marco) {
    if (!marco || this.marcos.has(marco) || this.pendingMarcos.has(marco)) return null;
    this.pendingMarcos.add(marco);
    const res = await this.action("visitar", { marco });
    this.pendingMarcos.delete(marco);
    return res;
  }

  /** Equipa uma arma da bolsa (o servidor valida tipo e posse). @param {string} itemId @returns {Promise<object>} */
  equip(itemId) {
    return this.action("equipar", { item: itemId });
  }

  /**
   * Informa um abate real (nunca o boneco de treino). O servidor sorteia cobre e drops e avança contratos.
   * Resposta: {ok, message, gained, cobre, state}.
   * @param {string} tipo chave de enemies.json
   * @param {string} spawnId id do ponto de spawn (city.json enemySpawns)
   * @returns {Promise<object>}
   */
  reportKill(tipo, spawnId) {
    return this.action("abater", { inimigo: tipo, spawn: spawnId });
  }

  /**
   * Derrota do jogador. Resposta: {ok, message, respawn: "cidade"|"acampamento", state} (state.status já restaurado).
   * @param {string} zoneKey zona onde caiu
   * @param {boolean} extramuros fora da muralha
   * @returns {Promise<object>}
   */
  defeat(zoneKey, extramuros) {
    return this.action("derrota", { local: zoneKey || "", extramuros: Boolean(extramuros) });
  }
}

// --------------------------------------------------------------------------------------------
// Corpo do jogador: vida, mana, vigor (fôlego para correr) e calor (chuva esfria, telhado e fogo aquecem)
// --------------------------------------------------------------------------------------------

// Histerese da exaustão: ao zerar correndo o sprint trava; volta com vigor >= RECOVER_RATIO do máximo, ou
// soltando e apertando o Shift de novo com vigor >= REPRESS_RATIO. A regeneração pausa EXHAUST_PAUSE s.
export const STAMINA = Object.freeze({
  recoverRatio: 0.25,
  repressRatio: 0.1,
  exhaustPause: 0.7,
});

// Regeneração passiva (por segundo): mana sempre (+ bônus da arma), vida só fora de combate
export const REGEN = Object.freeze({
  manaPerSecond: 2.0,
  vidaPerSecond: 0.6,
});

export class PlayerStats extends EventTarget {
  /** @param {GameState} game */
  constructor(game) {
    super();
    this.game = game;
    const def = game.statusDef;
    this.maxVigor = def.vigor.max;
    this.maxCalor = def.calor.max;
    this.maxVida = def.vida ? def.vida.max : 100;
    this.maxMana = def.mana ? def.mana.max : 60;
    this.vigor = def.vigor.inicial ?? 80;
    this.calor = def.calor.inicial ?? 70;
    this.vida = def.vida ? def.vida.inicial : this.maxVida;
    this.mana = def.mana ? def.mana.inicial : this.maxMana;
    this.folego = 0;
    this.exhausted = false;
    /** segundos restantes sem regenerar vigor após a exaustão */
    this.regenPause = 0;
    /** Shift estava pressionado no último canRun/update (borda de "apertou de novo") */
    this.runHeld = false;
    this.syncTimer = 0;
    this.lastSynced = { vigor: -1, calor: -1, vida: -1, mana: -1 };
    // Fonte do relógio/clima a salvar junto (Atmosphere.snapshot); ligada pelo app.js
    this.worldClock = null;
  }

  /** @param {object|null|undefined} status */
  load(status) {
    if (!status) return;
    this.vigor = clamp(Number(status.vigor ?? this.vigor), 0, this.maxVigor);
    this.calor = clamp(Number(status.calor ?? this.calor), 0, this.maxCalor);
    this.vida = clamp(Number(status.vida ?? this.vida), 0, this.maxVida);
    this.mana = clamp(Number(status.mana ?? this.mana), 0, this.maxMana);
    this.exhausted = this.vigor <= 0;
    this.regenPause = 0;
    this.dispatchEvent(new Event("change"));
  }

  /**
   * Decide se o jogador pode correr neste quadro. O player chama UMA vez por frame (inclusive parado),
   * com o estado do Shift: é assim que a histerese percebe "soltou e apertou de novo".
   * @param {boolean} wantsRun Shift pressionado
   * @returns {boolean}
   */
  canRun(wantsRun) {
    const want = Boolean(wantsRun);
    const pressed = want && !this.runHeld;
    this.runHeld = want;
    if (this.folego > 0) return want;
    if (!this.exhausted && this.vigor <= 0) this.exhausted = true;
    if (this.exhausted) {
      const ratio = this.vigor / this.maxVigor;
      if (ratio >= STAMINA.recoverRatio || (pressed && ratio >= STAMINA.repressRatio)) this.exhausted = false;
    }
    return want && !this.exhausted;
  }

  speedFactor() {
    return this.calor < CONFIG.stats.coldThreshold ? CONFIG.player.coldSpeedFactor : 1;
  }

  get cold() {
    return this.calor < CONFIG.stats.coldThreshold;
  }

  /** @returns {boolean} vida zerada */
  get dead() {
    return this.vida <= 0;
  }

  /** @param {number} amount @returns {number} dano efetivamente aplicado */
  damage(amount) {
    const before = this.vida;
    this.vida = clamp(this.vida - Math.max(0, Number(amount) || 0), 0, this.maxVida);
    const dealt = before - this.vida;
    if (dealt > 0) this.dispatchEvent(new Event("change"));
    return dealt;
  }

  /** @param {number} amount @returns {number} vida efetivamente recuperada */
  heal(amount) {
    const before = this.vida;
    this.vida = clamp(this.vida + Math.max(0, Number(amount) || 0), 0, this.maxVida);
    const healed = this.vida - before;
    if (healed > 0) this.dispatchEvent(new Event("change"));
    return healed;
  }

  /** @param {number} amount @returns {number} mana efetivamente recuperada */
  restoreMana(amount) {
    const before = this.mana;
    this.mana = clamp(this.mana + Math.max(0, Number(amount) || 0), 0, this.maxMana);
    const restored = this.mana - before;
    if (restored > 0) this.dispatchEvent(new Event("change"));
    return restored;
  }

  /** @param {number} cost @returns {boolean} false (e nada gasto) se faltar mana */
  spendMana(cost) {
    const c = Math.max(0, Number(cost) || 0);
    if (this.mana < c) return false;
    this.mana -= c;
    this.dispatchEvent(new Event("change"));
    return true;
  }

  /** @param {number} cost @returns {boolean} false (e nada gasto) se faltar vigor */
  spendVigor(cost) {
    const c = Math.max(0, Number(cost) || 0);
    if (this.vigor < c) return false;
    this.vigor -= c;
    this.dispatchEvent(new Event("change"));
    return true;
  }

  /** @param {{vigor?: number, calor?: number, vida?: number, mana?: number, buff?: {id: string, segundos: number}}|null|undefined} effect */
  apply(effect) {
    if (!effect) return;
    if (effect.vigor) this.vigor = clamp(this.vigor + effect.vigor, 0, this.maxVigor);
    if (effect.calor) this.calor = clamp(this.calor + effect.calor, 0, this.maxCalor);
    if (effect.vida) this.vida = clamp(this.vida + effect.vida, 0, this.maxVida);
    if (effect.mana) this.mana = clamp(this.mana + effect.mana, 0, this.maxMana);
    if (effect.buff && effect.buff.id === "folego") this.folego = Math.max(this.folego, effect.buff.segundos);
    if (this.vigor >= this.maxVigor * STAMINA.recoverRatio) {
      this.exhausted = false;
      this.regenPause = 0;
    }
    this.dispatchEvent(new Event("change"));
  }

  /**
   * @param {number} dt
   * @param {{running: boolean, moving: boolean, seated: boolean, rain: number, night: number, sheltered: boolean,
   *   nearFire: boolean, wantsRun?: boolean, inCombat?: boolean, manaRegenBonus?: number}} ctx
   */
  update(dt, ctx) {
    const s = CONFIG.stats;
    this.folego = Math.max(0, this.folego - dt);
    // Shift solto em qualquer quadro conta como "soltou" mesmo se o player não chamou canRun parado
    if (ctx.wantsRun === false) this.runHeld = false;
    if (ctx.running && this.folego <= 0) {
      this.vigor = Math.max(0, this.vigor - s.sprintDrain * dt);
      if (this.vigor <= 0) {
        this.exhausted = true;
        this.regenPause = STAMINA.exhaustPause;
      }
    } else if (this.regenPause > 0) {
      this.regenPause = Math.max(0, this.regenPause - dt);
    } else {
      // Sentado num banco o fôlego volta bem mais rápido
      const rest = ctx.seated ? CONFIG.props.seat.vigorRegenFactor : ctx.moving ? 0.5 : 1;
      this.vigor = Math.min(this.maxVigor, this.vigor + s.vigorRegen * dt * rest);
      if (this.exhausted && this.vigor >= this.maxVigor * STAMINA.recoverRatio) this.exhausted = false;
    }
    if (this.vida > 0) {
      this.mana = Math.min(this.maxMana, this.mana + (REGEN.manaPerSecond + (ctx.manaRegenBonus || 0)) * dt);
      if (!ctx.inCombat) this.vida = Math.min(this.maxVida, this.vida + REGEN.vidaPerSecond * dt);
    }
    const resist = this.game.qty("amuleto_trevo") > 0 ? 1 - (this.game.items.amuleto_trevo.passivo?.calor_resistencia || 0) : 1;
    let dCalor = 0;
    if (ctx.nearFire) dCalor += s.fireWarmPerSecond;
    if (ctx.sheltered) dCalor += s.roofWarmPerSecond;
    else dCalor -= (s.rainColdPerSecond * ctx.rain + s.nightColdPerSecond * ctx.night) * resist;
    if (!ctx.sheltered && ctx.rain < 0.1 && ctx.night < 0.5) dCalor += 0.4;
    this.calor = Math.max(0, Math.min(this.maxCalor, this.calor + dCalor * dt));
    this.syncTimer += dt;
    if (this.syncTimer > s.syncEvery) {
      this.syncTimer = 0;
      this.sync();
    }
  }

  sync() {
    const v = Math.round(this.vigor);
    const c = Math.round(this.calor);
    const h = Math.round(this.vida);
    const m = Math.round(this.mana);
    const last = this.lastSynced;
    // O relógio anda sempre: com ele ligado, todo ciclo salva (senão a hora voltaria ao recarregar)
    if (!this.worldClock && v === last.vigor && c === last.calor && h === last.vida && m === last.mana) return;
    last.vigor = v;
    last.calor = c;
    last.vida = h;
    last.mana = m;
    const payload = { acao: "sincronizar_status", status: { vigor: v, calor: c, vida: h, mana: m } };
    if (this.worldClock) payload.mundo = this.worldClock.snapshot();
    const body = JSON.stringify(payload);
    fetch("/api/acao", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
  }
}

/** @param {number} v @param {number} lo @param {number} hi @returns {number} */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
