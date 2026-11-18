import { CONFIG } from "../config.js";
import { $, iconInto } from "./common.js";

// HUD: só escreve no DOM quando o valor muda (nada de layout thrash por frame)
export class Hud {
  constructor(game, stats) {
    this.game = game;
    this.stats = stats;
    this.el = {
      zoneName: $("hud-zone-name"),
      zoneSub: $("hud-zone-sub"),
      clock: $("hud-clock"),
      weather: $("hud-weather"),
      weatherDot: $("hud-weather-dot"),
      day: $("hud-day"),
      prompt: $("interaction-prompt"),
      promptText: document.querySelector("#interaction-prompt .prompt-text"),
      toast: $("gameplay-toast"),
      stage: $("state-stage"),
      humor: $("state-humor"),
      coins: $("hud-coin-val"),
      tracker: $("quest-tracker-list"),
      vigorBar: $("bar-vigor"),
      vigorVal: $("val-vigor"),
      calorBar: $("bar-calor"),
      calorVal: $("val-calor"),
      statVigor: $("stat-vigor"),
      statCalor: $("stat-calor"),
      effects: $("hud-effects"),
      controls: $("controls-card"),
      zoneCard: $("zone-card"),
      zcTitle: $("zc-title"),
      zcSub: $("zc-sub"),
    };
    Object.assign(this.el, {
      vidaBar: $("bar-vida"),
      vidaVal: $("val-vida"),
      manaBar: $("bar-mana"),
      manaVal: $("val-mana"),
      statVida: $("stat-vida"),
      statMana: $("stat-mana"),
      spellBar: $("spell-bar"),
      damageLayer: $("damage-layer"),
      hurtFlash: $("hurt-flash"),
      faint: $("faint-overlay"),
    });
    this.bars = ["prox", "conf", "tens"].map((k) => ({ bar: $(`bar-${k}`), val: $(`val-${k}`) }));
    this.cache = Object.create(null);
    this.toastTimer = null;
    this.zoneCardTimer = null;
    this.lastCardZone = "";
    this.statTimer = 0;
    this.spellSlots = this.buildSpellBar();
    this.numbers = this.buildNumberPool(CONFIG.combat.numbers.pool);
    this.numberCursor = 0;
    game.addEventListener("change", () => this.renderGame());
    setTimeout(() => this.el.controls.classList.add("faded"), 25000);
  }

  // ---- Magias -------------------------------------------------------------------------------------

  /**
   * Monta os slots 1/2/3 a partir de CONFIG.combat.spells (uma vez).
   * @returns {Array<{root: HTMLElement, cd: HTMLElement, cache: {cd: number, ok: boolean, sel: boolean}}>}
   */
  buildSpellBar() {
    const bar = this.el.spellBar;
    if (!bar) return [];
    const slots = [];
    CONFIG.combat.spells.forEach((sp, i) => {
      const root = document.createElement("div");
      root.className = "spell";
      root.title = `${sp.nome} — ${sp.custo} de mana`;
      root.innerHTML = `<span class="sp-key"></span><span class="sp-sigla"></span><span class="sp-cost"></span><span class="sp-sel">DIR</span><div class="sp-cd"></div>`;
      root.children[0].textContent = String(i + 1);
      root.children[1].textContent = sp.sigla;
      root.children[2].textContent = `${sp.custo} mana`;
      bar.appendChild(root);
      slots.push({ root, cd: root.lastChild, cache: { cd: -1, ok: true, sel: false } });
    });
    return slots;
  }

  /**
   * Estado visual de um slot de magia (escreve no DOM só quando muda; recarga quantizada a 1/40).
   * @param {number} index 0..2
   * @param {number} cooldownFrac 0 = pronta, 1 = acabou de lançar
   * @param {boolean} affordable há mana para o custo
   * @param {boolean} selected é a magia do clique direito
   */
  setSpellState(index, cooldownFrac, affordable, selected) {
    const slot = this.spellSlots[index];
    if (!slot) return;
    const c = slot.cache;
    const q = Math.ceil(Math.max(0, Math.min(1, cooldownFrac)) * 40) / 40;
    if (c.cd !== q) {
      c.cd = q;
      slot.cd.style.transform = `scaleY(${q})`;
    }
    if (c.ok !== affordable) {
      c.ok = affordable;
      slot.root.classList.toggle("nomana", !affordable);
    }
    if (c.sel !== selected) {
      c.sel = selected;
      slot.root.classList.toggle("selected", selected);
    }
  }

  // ---- Números de dano flutuantes (pool fixo criado uma vez) ----------------------------------------

  /**
   * @param {number} size
   * @returns {Array<{el: HTMLElement, busy: boolean, kind: string}>}
   */
  buildNumberPool(size) {
    const layer = this.el.damageLayer;
    const pool = [];
    for (let i = 0; i < size; i++) {
      const el = document.createElement("div");
      el.className = "dmg-num";
      if (layer) layer.appendChild(el);
      pool.push({ el, busy: false, kind: "" });
    }
    return pool;
  }

  /**
   * Reserva um número do pool (reaproveita o mais antigo se todos estiverem em uso).
   * @param {string} text
   * @param {string} kind "" | "crit" | "magic" | "hurt" | "heal" | "mana" | "miss"
   * @returns {number} índice para placeNumber/releaseNumber
   */
  acquireNumber(text, kind) {
    const pool = this.numbers;
    let index = -1;
    for (let i = 0; i < pool.length; i++) {
      const j = (this.numberCursor + i) % pool.length;
      if (!pool[j].busy) {
        index = j;
        break;
      }
    }
    if (index < 0) index = this.numberCursor;
    this.numberCursor = (index + 1) % pool.length;
    const n = pool[index];
    n.busy = true;
    n.el.textContent = text;
    if (n.kind !== kind) {
      n.el.className = kind ? `dmg-num ${kind}` : "dmg-num";
      n.kind = kind;
    }
    return index;
  }

  /**
   * Posiciona um número reservado (px de tela). Sem alocação além da string de transform.
   * @param {number} index
   * @param {number} x
   * @param {number} y
   * @param {number} alpha 0..1
   * @param {number} scale
   */
  placeNumber(index, x, y, alpha, scale) {
    const el = this.numbers[index].el;
    el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%) scale(${scale.toFixed(3)})`;
    el.style.opacity = alpha.toFixed(3);
  }

  /** @param {number} index */
  releaseNumber(index) {
    const n = this.numbers[index];
    n.busy = false;
    n.el.style.opacity = "0";
  }

  // ---- Dano recebido e desmaio --------------------------------------------------------------------

  /** Vinheta vermelha curta (reinicia a animação CSS). */
  flashHurt() {
    const el = this.el.hurtFlash;
    if (!el) return;
    el.classList.remove("hit");
    void el.offsetWidth;
    el.classList.add("hit");
  }

  /** @param {boolean} on mostra/esconde "Você desmaiou..." com fade */
  setFainted(on) {
    const el = this.el.faint;
    if (!el || this.cache.faint === on) return;
    this.cache.faint = on;
    el.classList.toggle("show", on);
    el.setAttribute("aria-hidden", String(!on));
  }

  set(key, el, value, prop = "textContent") {
    if (this.cache[key] === value) return;
    this.cache[key] = value;
    el[prop] = value;
  }

  setZone(zone) {
    this.set("zn", this.el.zoneName, zone.name);
    this.set("zs", this.el.zoneSub, zone.sub);
    // Cartão de título estilo anime ao entrar num lugar com nome (não repete o mesmo em seguida)
    if (zone.priority >= 1 && zone.key !== this.lastCardZone && !zone.key.endsWith("_Frente")) {
      this.lastCardZone = zone.key;
      this.showZoneCard(zone.name, zone.sub);
    }
  }

  showZoneCard(title, sub) {
    const el = this.el;
    el.zcTitle.textContent = title;
    el.zcSub.textContent = sub;
    el.zoneCard.classList.remove("show");
    void el.zoneCard.offsetWidth;
    el.zoneCard.classList.add("show");
    clearTimeout(this.zoneCardTimer);
    this.zoneCardTimer = setTimeout(() => el.zoneCard.classList.remove("show"), 2600);
  }

  setClock(label, day, rain, night) {
    this.set("clk", this.el.clock, label);
    this.set("day", this.el.day, String(day));
    const w = rain > 0.7 ? "Chuva forte" : rain > 0.3 ? "Chuva" : rain > 0.08 ? "Garoa" : night > 0.5 ? "Céu limpo" : "Ensolarado";
    this.set("wth", this.el.weather, w);
    const dot = rain > 0.08 ? "#5bc0eb" : night > 0.5 ? "#c9c3e6" : "#ffd27a";
    if (this.cache.dot !== dot) {
      this.cache.dot = dot;
      this.el.weatherDot.style.background = dot;
      this.el.weatherDot.style.boxShadow = `0 0 8px ${dot}`;
    }
  }

  setPrompt(text, muted = false) {
    const key = `${text || ""}|${muted}`;
    if (this.cache.prompt === key) return;
    this.cache.prompt = key;
    if (text) {
      this.el.promptText.textContent = text;
      this.el.prompt.classList.add("visible");
      this.el.prompt.classList.toggle("muted", muted);
    } else {
      this.el.prompt.classList.remove("visible");
    }
  }

  toast(text, kind = "info", itemId = null) {
    const t = this.el.toast;
    t.innerHTML = "";
    if (itemId) {
      const ic = document.createElement("span");
      ic.style.cssText = "width:34px;height:34px;border-radius:6px;overflow:hidden;display:inline-block;flex-shrink:0";
      iconInto(ic, itemId, this.game.items[itemId] || (itemId === "cobre" ? this.game.coin : null));
      t.appendChild(ic);
    }
    const span = document.createElement("span");
    span.textContent = text;
    t.appendChild(span);
    t.dataset.kind = kind;
    t.classList.add("visible");
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.remove("visible"), CONFIG.ui.toastMs);
  }

  renderRelation(state) {
    if (!state) return;
    const pct = (v) => Math.round(Math.max(0, Math.min(1, Number(v || 0))) * 100);
    const values = [pct(state.proximidade), pct(state.confianca), pct(state.tensao)];
    for (let i = 0; i < this.bars.length; i++) {
      this.bars[i].bar.style.width = `${Math.max(4, values[i])}%`;
      this.bars[i].val.textContent = `${values[i]}%`;
    }
    this.el.stage.textContent = state.estagio || "desconhecidos";
    if (state.humor) this.el.humor.textContent = state.humor;
  }

  renderGame() {
    const g = this.game;
    this.set("coins", this.el.coins, String(g.cobre));
    const active = g.activeQuests();
    const html = active.length
      ? active.slice(0, 3).map(([qid, m]) => `<div class="q"><b>${g.quests[qid].titulo}</b>${m.texto}</div>`).join("")
      : `<div class="q done"><b>Sem missões ativas</b>Converse com os moradores — quem tem trabalho mostra um <b style="display:inline;color:#8fdc9a">!</b> no menu.</div>`;
    this.set("tracker", this.el.tracker, html, "innerHTML");
  }

  renderStats(dt) {
    this.statTimer += dt;
    if (this.statTimer < 0.15) return;
    this.statTimer = 0;
    const s = this.stats;
    const hp = Math.round(s.vida);
    const mp = Math.round(s.mana);
    this.set("hb", this.el.vidaBar.style, `${(hp / s.maxVida) * 100}%`, "width");
    this.set("hv", this.el.vidaVal, String(hp));
    this.set("mb", this.el.manaBar.style, `${(mp / s.maxMana) * 100}%`, "width");
    this.set("mv", this.el.manaVal, String(mp));
    const low = hp <= s.maxVida * 0.25;
    if (this.cache.low !== low) {
      this.cache.low = low;
      this.el.statVida.classList.toggle("low", low);
    }
    const dry = mp < CONFIG.combat.spells[0].custo;
    if (this.cache.dry !== dry) {
      this.cache.dry = dry;
      this.el.statMana.classList.toggle("dry", dry);
    }
    const v = Math.round(s.vigor);
    const c = Math.round(s.calor);
    this.set("vb", this.el.vigorBar.style, `${(v / s.maxVigor) * 100}%`, "width");
    this.set("vv", this.el.vigorVal, String(v));
    this.set("cb", this.el.calorBar.style, `${(c / s.maxCalor) * 100}%`, "width");
    this.set("cv", this.el.calorVal, String(c));
    const cold = s.cold;
    const tired = s.exhausted;
    if (this.cache.cold !== cold) {
      this.cache.cold = cold;
      this.el.statCalor.classList.toggle("cold", cold);
    }
    if (this.cache.tired !== tired) {
      this.cache.tired = tired;
      this.el.statVigor.classList.toggle("tired", tired);
    }
    const fx = [];
    if (s.folego > 0) fx.push(`Fôlego sem fim ${Math.ceil(s.folego)}s`);
    if (cold) fx.push("Com frio: passos lentos");
    if (tired) fx.push("Sem fôlego para correr");
    this.set("fx", this.el.effects, fx.join(" · "));
  }
}
