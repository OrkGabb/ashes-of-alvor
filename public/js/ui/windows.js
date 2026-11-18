import { $, describeEffect, iconInto, portraitInto } from "./common.js";

// Janelas modais leves: abrem/fecham por classe CSS; todas bloqueiam o movimento enquanto abertas.
class Window {
  constructor(id, manager) {
    this.el = $(id);
    this.manager = manager;
    this.isOpen = false;
    for (const b of this.el.querySelectorAll("[data-close]")) b.addEventListener("click", () => this.close());
  }

  open() {
    this.manager.closeAll(this);
    this.isOpen = true;
    this.render();
    this.el.classList.add("open");
    this.el.setAttribute("aria-hidden", "false");
    this.manager.sync();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.el.classList.remove("open");
    this.el.setAttribute("aria-hidden", "true");
    this.manager.sync();
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  render() {}
}

export class WindowManager {
  constructor(player) {
    this.player = player;
    this.windows = [];
  }

  add(w) {
    this.windows.push(w);
    return w;
  }

  closeAll(except = null) {
    for (const w of this.windows) if (w !== except) w.close();
  }

  get anyOpen() {
    return this.windows.some((w) => w.isOpen);
  }

  // E fecha as janelas de leitura rápida (placas); devolve true se fechou alguma
  closeOnInteract() {
    let closed = false;
    for (const w of this.windows) {
      if (w.isOpen && w.closeOnInteract) {
        w.close();
        closed = true;
      }
    }
    return closed;
  }

  sync() {
    const open = this.anyOpen;
    this.player.inputBlocked = open || this.dialogueOpen();
    if (open) this.player.releasePointer();
  }

  dialogueOpen() {
    return Boolean(this.dialogue && this.dialogue.isOpen);
  }
}

// ------------------------------------------------------------------------------------------------
// Menu de interação com NPC: conversar (narrador), missões (aceitar/entregar), loja
// ------------------------------------------------------------------------------------------------
export class NpcMenu extends Window {
  constructor(manager, { game, data, dialogue, shop, hud, audio }) {
    super("npc-menu", manager);
    this.game = game;
    this.data = data;
    this.dialogue = dialogue;
    this.shop = shop;
    this.hud = hud;
    this.audio = audio;
    this.agent = null;
    this.keyHandler = (e) => {
      if (!this.isOpen) return;
      const n = Number(e.key);
      if (n >= 1 && n <= this.options.length) {
        e.preventDefault();
        this.options[n - 1].run();
      }
    };
    window.addEventListener("keydown", this.keyHandler);
    this.options = [];
  }

  show(agent) {
    this.agent = agent;
    agent.beginTalk(this.dialogue.player.position);
    this.open();
  }

  close() {
    if (this.isOpen && this.agent && !this.dialogue.isOpen) this.agent.endTalk();
    super.close();
  }

  render() {
    const a = this.agent;
    if (!a) return;
    const def = this.data.npcs.npcs[a.id];
    portraitInto($("npcm-portrait"), a.id, def);
    $("npcm-name").textContent = def.nome;
    $("npcm-name").style.color = def.cor;
    $("npcm-role").textContent = def.titulo;
    $("npcm-activity").textContent = `Agora: ${a.statusLabel}`;
    const trust = this.game.confianca[a.id];
    $("npcm-trust").textContent = trust !== undefined ? `Confiança em você: ${Math.round(trust * 100)}%` : "Ainda não te conhece direito.";
    const opts = [];
    opts.push({ label: `Conversar com ${def.nome.split(" ").pop()}`, cls: "", run: () => this.talk() });
    for (const [qid, m] of this.game.turnInsFor(a.id)) {
      const obj = m.objetivo;
      const q = this.game.quests[qid];
      let label;
      let ready = true;
      if (obj.tipo === "entregar") {
        ready = this.game.qty(obj.item) >= (obj.qtd || 1);
        label = `Entregar ${this.game.items[obj.item].nome}${obj.qtd > 1 ? ` x${obj.qtd}` : ""}`;
      } else if (obj.tipo === "pagar") {
        ready = this.game.cobre >= obj.cobre;
        label = `Pagar ${obj.cobre} cobres — ${q.titulo}`;
      } else {
        label = `${q.titulo}: ${m.texto}`;
      }
      opts.push({ label: `${ready ? "" : "(falta) "}${label}`, cls: "turnin", run: () => this.turnIn(qid, label) });
    }
    for (const qid of this.game.offersFor(a.id)) {
      const q = this.game.quests[qid];
      opts.push({ label: `! ${q.titulo}`, cls: "quest", run: () => this.offer(qid) });
    }
    if (def.loja) opts.push({ label: `Comprar — ${def.loja.titulo}`, cls: "", run: () => this.openShop() });
    opts.push({ label: "Sair", cls: "", run: () => this.close() });
    this.options = opts;
    const box = $("npcm-options");
    box.innerHTML = "";
    opts.forEach((o, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `btn npcm-opt ${o.cls}`;
      b.innerHTML = `<span class="k">${i + 1}</span><span></span>`;
      b.lastChild.textContent = o.label;
      b.addEventListener("click", o.run);
      box.appendChild(b);
    });
  }

  talk() {
    const a = this.agent;
    super.close();
    this.dialogue.open(a);
  }

  turnIn(qid, label) {
    const a = this.agent;
    super.close();
    this.dialogue.open(a, { acao: "concluir", missao: qid, text: `[${label}]` });
  }

  offer(qid) {
    const a = this.agent;
    const q = this.game.quests[qid];
    super.close();
    this.dialogue.open(a, { acao: "aceitar", missao: qid, text: `[Pergunta sobre o pedido: ${q.titulo}]` });
  }

  openShop() {
    const a = this.agent;
    super.close();
    this.shop.show(a);
  }
}

// ------------------------------------------------------------------------------------------------
// Bolsa (B)
// ------------------------------------------------------------------------------------------------
const TYPE_LABEL = { consumivel: "usar", missao: "missão", chave: "chave", material: "material", equipamento: "arma" };

// Texto de efeito com vida/mana (describeEffect de common.js só conhece vigor/calor/buff)
function effectText(effect) {
  if (!effect) return "";
  const parts = [];
  if (effect.vida) parts.push(`+${effect.vida} vida`);
  if (effect.mana) parts.push(`+${effect.mana} mana`);
  const base = describeEffect(effect);
  if (base) parts.push(base);
  return parts.join(" · ");
}

// Atributos de combate de uma arma (campo "combate" do items.json)
function weaponText(c) {
  if (!c) return "";
  const parts = [`Dano ${c.dano_corpo}`, `alcance ${c.alcance} m`, `arco ${c.arco_graus}°`, `recarga ${c.recarga}s`];
  if (c.poder_magico && c.poder_magico !== 1) parts.push(`magia x${c.poder_magico}`);
  if (c.regen_mana) parts.push(`+${c.regen_mana} mana/s`);
  return parts.join(" · ");
}

export class BagWindow extends Window {
  constructor(manager, { game, stats, hud, audio, player }) {
    super("bag-window", manager);
    this.game = game;
    this.stats = stats;
    this.hud = hud;
    this.audio = audio;
    this.player = player;
    this.selected = null;
    this.equipping = false;
    game.addEventListener("change", () => {
      if (this.isOpen) this.render();
    });
  }

  render() {
    const g = this.game;
    $("bag-coins").textContent = g.cobre;
    const grid = $("bag-grid");
    grid.innerHTML = "";
    const entries = Object.entries(g.itens).filter(([, q]) => q > 0);
    if (this.selected && !g.itens[this.selected]) this.selected = null;
    if (!this.selected && entries.length) this.selected = entries[0][0];
    const total = Math.max(15, Math.ceil(entries.length / 5) * 5);
    for (let i = 0; i < total; i++) {
      const slot = document.createElement("div");
      const e = entries[i];
      if (!e) {
        slot.className = "slot empty";
        grid.appendChild(slot);
        continue;
      }
      const [id, qty] = e;
      const def = g.items[id];
      slot.className = `slot${id === this.selected ? " selected" : ""}`;
      iconInto(slot, id, def);
      if (qty > 1) {
        const q = document.createElement("span");
        q.className = "qty";
        q.textContent = `x${qty}`;
        slot.appendChild(q);
      }
      const t = document.createElement("span");
      t.className = "tag";
      t.textContent = this.isEquipped(id) ? "equipado" : TYPE_LABEL[def.tipo] || def.tipo;
      slot.appendChild(t);
      slot.title = def.nome;
      slot.addEventListener("click", () => {
        this.selected = id;
        this.render();
      });
      slot.addEventListener("dblclick", () => (def.tipo === "equipamento" ? this.equip(id) : this.use(id)));
      grid.appendChild(slot);
    }
    const det = $("bag-detail");
    det.innerHTML = "";
    if (!this.selected) {
      det.innerHTML = `<p style="color:var(--text-muted)">Bolsa vazia. Recolha coisas pelo mundo, compre nas lojas ou cumpra missões.</p>`;
      return;
    }
    const def = g.items[this.selected];
    const big = document.createElement("div");
    big.className = "big";
    iconInto(big, this.selected, def);
    det.appendChild(big);
    const h = document.createElement("h3");
    h.textContent = def.nome;
    det.appendChild(h);
    const p = document.createElement("p");
    p.textContent = def.descricao;
    det.appendChild(p);
    if (def.efeito) {
      const fx = document.createElement("div");
      fx.className = "fx";
      fx.textContent = effectText(def.efeito);
      det.appendChild(fx);
    }
    if (def.tipo === "equipamento") {
      const fx = document.createElement("div");
      fx.className = "fx";
      fx.textContent = weaponText(def.combate);
      det.appendChild(fx);
      const equipped = this.isEquipped(this.selected);
      const b = document.createElement("button");
      b.className = equipped ? "btn" : "btn primary";
      b.textContent = equipped ? "Equipado" : "Equipar (duplo clique)";
      b.disabled = equipped || this.equipping;
      const id = this.selected;
      b.addEventListener("click", () => this.equip(id));
      det.appendChild(b);
    }
    if (def.tipo === "consumivel") {
      const b = document.createElement("button");
      b.className = "btn primary";
      b.textContent = "Usar (duplo clique)";
      b.addEventListener("click", () => this.use(this.selected));
      det.appendChild(b);
    }
  }

  /**
   * @param {string} id
   * @returns {boolean} é a arma equipada agora
   */
  isEquipped(id) {
    const eq = this.game.equipado;
    return Boolean(eq && eq.arma === id);
  }

  /**
   * Equipa uma arma pelo servidor (game.equip); o Player troca o modelo da mão no evento "change".
   * @param {string} id
   * @returns {Promise<void>}
   */
  async equip(id) {
    const def = this.game.items[id];
    if (!def || def.tipo !== "equipamento" || this.isEquipped(id) || this.equipping) return;
    this.equipping = true;
    this.render();
    const res = await this.game.equip(id);
    this.equipping = false;
    if (res && res.ok) {
      this.audio.cue("use");
      this.hud.toast(res.message || `${def.nome} equipada.`, "success", id);
    } else {
      this.audio.cue("error");
      this.hud.toast((res && res.message) || "Não deu para equipar.", "warn");
    }
    this.render();
  }

  async use(id) {
    const def = this.game.items[id];
    if (!def || def.tipo !== "consumivel") return;
    const res = await this.game.action("usar", { item: id });
    if (res.ok) {
      this.stats.apply(res.effect);
      this.audio.cue("use");
      this.player.gesture("Use_Item");
      this.hud.toast(res.message, "success", id);
    } else {
      this.hud.toast(res.message || "Não deu.", "warn");
    }
    this.render();
  }
}

// ------------------------------------------------------------------------------------------------
// Diário (J)
// ------------------------------------------------------------------------------------------------
export class JournalWindow extends Window {
  constructor(manager, { game, data }) {
    super("journal-window", manager);
    this.game = game;
    this.data = data;
    game.addEventListener("change", () => {
      if (this.isOpen) this.render();
    });
  }

  questCard(qid, m) {
    const q = this.game.quests[qid];
    const giver = this.data.npcs.npcs[q.doador];
    const steps = q.etapas.map((et, i) => {
      const cls = m.estado === "concluida" || i < m.etapa ? "done" : i === m.etapa ? "cur" : "";
      return `<li class="${cls}">${et.texto}</li>`;
    }).join("");
    return `<div class="jq ${m.estado}"><h4>${q.titulo}<span>${giver ? giver.nome : ""}</span></h4><p>${q.resumo}</p><ol>${steps}</ol></div>`;
  }

  render() {
    const g = this.game;
    const active = g.activeQuests();
    const done = Object.entries(g.missoes).filter(([, m]) => m.estado === "concluida");
    const offers = Object.entries(g.disponiveis).flatMap(([npc, qs]) => qs.map((q) => [npc, q]));
    let html = `<div class="section-label">Em andamento</div>`;
    html += active.length ? active.map(([q, m]) => this.questCard(q, m)).join("") : `<p style="color:var(--text-muted)">Nenhuma missão ativa.</p>`;
    if (offers.length) {
      html += `<div class="section-label">Pedidos disponíveis pela cidade</div>`;
      html += offers.map(([npc, q]) => `<div class="jq"><h4>! ${g.quests[q].titulo}<span>${this.data.npcs.npcs[npc].nome}</span></h4><p>${g.quests[q].resumo}</p></div>`).join("");
    }
    if (done.length) {
      html += `<div class="section-label">Concluídas</div>`;
      html += done.map(([q, m]) => this.questCard(q, m)).join("");
    }
    $("journal-body").innerHTML = html;
  }
}

// ------------------------------------------------------------------------------------------------
// Loja
// ------------------------------------------------------------------------------------------------
export class ShopWindow extends Window {
  constructor(manager, { game, data, hud, audio }) {
    super("shop-window", manager);
    this.game = game;
    this.data = data;
    this.hud = hud;
    this.audio = audio;
    this.agent = null;
    game.addEventListener("change", () => {
      if (this.isOpen) this.render();
    });
  }

  show(agent) {
    this.agent = agent;
    this.open();
  }

  close() {
    if (this.isOpen && this.agent) this.agent.endTalk();
    super.close();
  }

  render() {
    const def = this.data.npcs.npcs[this.agent.id];
    $("shop-title").textContent = def.loja.titulo.toUpperCase();
    $("shop-coins").textContent = this.game.cobre;
    const body = $("shop-body");
    body.innerHTML = "";
    for (const id of def.loja.itens) {
      const it = this.game.items[id];
      const row = document.createElement("div");
      row.className = "shop-row";
      const ic = document.createElement("div");
      ic.className = "ic";
      iconInto(ic, id, it);
      row.appendChild(ic);
      const info = document.createElement("div");
      info.innerHTML = `<h5></h5><small></small><small style="color:var(--ok)"></small>`;
      info.children[0].textContent = it.nome;
      info.children[1].textContent = it.descricao;
      info.children[2].textContent = `${effectText(it.efeito) || weaponText(it.combate)}${this.game.qty(id) ? ` · na bolsa: ${this.game.qty(id)}` : ""}`;
      row.appendChild(info);
      const b = document.createElement("button");
      b.className = "btn primary";
      b.textContent = `${it.preco} cobres`;
      b.disabled = this.game.cobre < it.preco;
      b.addEventListener("click", () => this.buy(id));
      row.appendChild(b);
      body.appendChild(row);
    }
  }

  async buy(id) {
    const res = await this.game.action("comprar", { item: id, npc: this.agent.id });
    if (res.ok) {
      this.audio.cue("coin");
      this.hud.toast(res.message, "success", id);
    } else {
      this.audio.cue("error");
      this.hud.toast(res.message, "warn");
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Quadro de contratos da Guilda
// ------------------------------------------------------------------------------------------------
export class BoardWindow extends Window {
  constructor(manager, { game, data }) {
    super("board-window", manager);
    this.game = game;
    this.data = data;
  }

  render() {
    const g = this.game;
    const registered = g.qty("cartao_guilda") > 0;
    const contracts = Object.entries(g.quests).filter(([, q]) => q.requer_item === "cartao_guilda");
    let html = registered
      ? `<p style="color:var(--ok)">Seu Cartão de Aventureiro (Rank F) está em dia. Contratos para o seu rank:</p>`
      : `<p style="color:#ffd2bf">Um aviso pregado no topo: <i>"Contratos só para aventureiros registrados. Registro com a Maren, no balcão — taxa de 10 cobres."</i></p>`;
    for (const [qid, q] of contracts) {
      const m = g.missoes[qid];
      const giver = this.data.npcs.npcs[q.doador];
      const status = m ? (m.estado === "concluida" ? "Cumprido" : "Em andamento") : registered ? `Fale com ${giver.nome}` : "Exige registro";
      html += `<div class="jq"><h4>${q.titulo}<span>${status}</span></h4><p>${q.resumo}</p></div>`;
    }
    html += `<div class="jq concluida"><h4>Exterminar goblins na Mata Cinzenta<span>Rank D+</span></h4><p>Recompensa alta. Portão Sul fechado à noite por ordem do Capitão Aldric.</p></div>`;
    html += `<div class="jq concluida"><h4>Escolta de caravana até Vaeloria<span>Rank C+</span></h4><p>Partida quando a estrada reabrir.</p></div>`;
    $("board-body").innerHTML = html;
  }
}

// ------------------------------------------------------------------------------------------------
// Placas e avisos do mundo (interativo "sign"): pergaminho com título e texto; Esc ou E fecha
// ------------------------------------------------------------------------------------------------
export class SignWindow extends Window {
  constructor(manager) {
    super("sign-window", manager);
    this.spec = null;
    this.closeOnInteract = true;
  }

  show(spec) {
    this.spec = spec;
    this.open();
  }

  render() {
    const s = this.spec;
    if (!s) return;
    $("sign-title").textContent = s.title || s.label || "";
    const body = $("sign-text");
    body.innerHTML = "";
    for (const para of String(s.text || "").split(/\n+/)) {
      if (!para.trim()) continue;
      const p = document.createElement("p");
      p.textContent = para;
      body.appendChild(p);
    }
  }
}

