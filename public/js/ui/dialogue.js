import { CONFIG } from "../config.js";
import { $, fallbackPortraitDataUrl, portraitUrl } from "./common.js";

// Diálogo com qualquer NPC nomeado: retrato do interlocutor, pílulas de quem está presente,
// typewriter dirigido pelo loop do jogo e streaming SSE do narrador.
// Uma conversa por NPC (this.threads, espelho do histórico por NPC do servidor): abrir o diálogo com a Rosa
// mostra só a conversa com a Rosa, e o modelo também só recebe ela.
//
// Rolagem para leitura: antes, cada caractere forçava scrollTop = scrollHeight, então o texto
// fugia enquanto era gerado. Agora o log só acompanha o fim do texto enquanto o COMEÇO da resposta
// ainda está visível; quando a resposta enche a tela, a leitura fica parada no início e aparece
// "Mais texto ↓". Se o jogador rolar para cima, nada o puxa de volta.

const SPEECH_VERBS = "diz|fala|pergunta|responde|murmura|resmunga|retruca|avisa|aponta|provoca|sorri|ri|comenta|rebate|sussurra|explica|grita|completa|insiste|suspira";

function stripStateTags(text) {
  return text.replace(/<(?:estado|status|state)\b[^>]*>[\s\S]*$/gi, "").replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/gi, "").trimEnd();
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class Dialogue {
  constructor({ hud, game, npcs, player, audio, data, getScene }) {
    this.hud = hud;
    this.game = game;
    this.npcs = npcs;
    this.player = player;
    this.audio = audio;
    this.data = data;
    this.getScene = getScene;
    this.isOpen = false;
    this.streaming = false;
    this.talkingTo = null;
    this.present = [];
    this.speaker = "";
    this.queue = "";
    this.charBudget = 0;
    this.activeEl = null;
    this.onDrained = null;
    this.follow = true;
    this.lastState = null;
    this.speakerRes = new Map();
    this.threads = new Map(); // id do NPC -> [{ role, text }]
    this.el = {
      modal: $("dialogue-modal"),
      log: $("dialogue-log"),
      form: $("chat-form"),
      input: $("chat-input"),
      send: $("send-btn"),
      panel: $("dlg-portrait-panel"),
      img: $("dlg-portrait-img"),
      name: $("dlg-portrait-name"),
      role: $("dlg-portrait-role"),
      pills: $("dlg-pills"),
      chips: $("quick-chips"),
      model: $("dlg-model-tag"),
      reset: $("btn-new-journey"),
      more: $("scroll-more"),
    };
    this.bind();
  }

  bind() {
    const el = this.el;
    el.form.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = el.input.value.trim();
      if (!text || this.streaming) return;
      el.input.value = "";
      this.send(text);
    });
    $("btn-close-dlg").addEventListener("click", () => this.close());
    $("btn-clear-chat").addEventListener("click", () => this.reset(false));
    let confirmTimer = null;
    el.reset.addEventListener("click", () => {
      if (el.reset.dataset.confirm === "1") {
        clearTimeout(confirmTimer);
        el.reset.dataset.confirm = "";
        el.reset.textContent = "Nova Jornada";
        this.reset(true);
        return;
      }
      el.reset.dataset.confirm = "1";
      el.reset.textContent = "Confirmar?";
      confirmTimer = setTimeout(() => {
        el.reset.dataset.confirm = "";
        el.reset.textContent = "Nova Jornada";
      }, 3000);
    });
    // O jogador rolou: só volta a acompanhar se ele mesmo descer até o fim
    el.log.addEventListener("scroll", () => {
      const slack = el.log.scrollHeight - el.log.scrollTop - el.log.clientHeight;
      if (this.programmaticScroll) {
        this.programmaticScroll = false;
        return;
      }
      this.follow = slack < CONFIG.ui.autoScrollSlack;
      this.updateMore();
    }, { passive: true });
    el.log.addEventListener("wheel", (e) => {
      if (e.deltaY < 0) this.follow = false;
    }, { passive: true });
    el.more.addEventListener("click", () => {
      el.log.scrollTo({ top: el.log.scrollHeight, behavior: "smooth" });
      this.follow = true;
    });
    el.img.addEventListener("error", () => {
      const def = this.data.npcs.npcs[this.speaker];
      if (def && !el.img.src.startsWith("data:")) el.img.src = fallbackPortraitDataUrl(def.nome, def.cor);
    });
  }

  // ---------------------------------------------------------------------------- retrato e falantes
  setSpeaker(id) {
    const def = this.data.npcs.npcs[id];
    if (!def) return;
    const changed = this.speaker !== id;
    this.speaker = id;
    const el = this.el;
    el.panel.style.setProperty("--c", def.cor);
    if (changed) {
      el.img.style.opacity = "0.35";
      el.img.onload = () => {
        el.img.style.opacity = "1";
      };
      el.img.src = portraitUrl(id);
      el.img.alt = `Retrato de ${def.nome}`;
    }
    el.name.textContent = def.nome.toUpperCase();
    const trust = this.game.confianca[id];
    const s = this.lastState;
    if (id === "luna" && s && s.humor) el.role.textContent = `${def.titulo} · ${s.humor}`;
    else el.role.textContent = trust !== undefined ? `${def.titulo} · confiança ${Math.round(trust * 100)}%` : def.titulo;
    for (const pill of el.pills.children) pill.classList.toggle("active", pill.dataset.id === id);
    const agent = this.npcs.byId(id);
    if (this.isOpen && agent) agent.beginTalk(this.player.position);
  }

  speakerRegex(id) {
    if (!this.speakerRes.has(id)) {
      const def = this.data.npcs.npcs[id];
      const names = [def.nome, ...def.nome.split(" ").filter((w) => w.length > 3 && !["Velho", "Dona", "Irmã", "Capitão"].includes(w))];
      const alt = names.map(escapeRe).join("|");
      this.speakerRes.set(id, {
        speech: new RegExp(`(?:—[^—\\n]+—\\s*(?:${SPEECH_VERBS})?\\s*(?:${alt})\\b|\\b(?:${alt})\\s+(?:${SPEECH_VERBS})\\b)`, "gi"),
        name: new RegExp(`\\b(?:${alt})\\b`, "gi"),
      });
    }
    return this.speakerRes.get(id);
  }

  detectSpeaker(text) {
    const ids = this.present.map((a) => a.id);
    if (!text || !ids.length) return this.speaker;
    const seg = text.length > 280 ? text.slice(-280) : text;
    let best = null;
    let bestIdx = -1;
    for (const kind of ["speech", "name"]) {
      for (const id of ids) {
        const re = this.speakerRegex(id)[kind];
        re.lastIndex = 0;
        let m;
        let idx = -1;
        while ((m = re.exec(seg)) !== null) idx = m.index;
        if (idx > bestIdx) {
          bestIdx = idx;
          best = id;
        }
      }
      if (best) return best;
    }
    return this.speaker;
  }

  renderPills() {
    const el = this.el;
    el.pills.innerHTML = "";
    for (const a of this.present) {
      const def = this.data.npcs.npcs[a.id];
      const pill = document.createElement("div");
      pill.className = "speaker-pill";
      pill.dataset.id = a.id;
      pill.style.setProperty("--c", def.cor);
      pill.title = `Falar com ${def.nome}`;
      pill.innerHTML = `<span class="dot"></span>${def.nome.toUpperCase()}`;
      pill.addEventListener("click", () => {
        if (this.streaming || this.talkingTo === a) return;
        this.talkingTo = a;
        this.setSpeaker(a.id);
        this.renderThread(a.id);
        this.renderChips();
      });
      el.pills.appendChild(pill);
    }
  }

  renderChips() {
    const el = this.el;
    el.chips.innerHTML = "";
    const target = this.talkingTo;
    if (!target) return;
    const def = this.data.npcs.npcs[target.id];
    const add = (label, onClick, cls = "chip") => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = cls;
      b.textContent = label;
      b.disabled = this.streaming;
      b.addEventListener("click", onClick);
      el.chips.appendChild(b);
    };
    for (const [qid, m] of this.game.turnInsFor(target.id)) {
      const q = this.game.quests[qid];
      const obj = m.objetivo;
      const label = obj.tipo === "entregar" ? `Entregar: ${this.game.items[obj.item].nome}` : obj.tipo === "pagar" ? `Pagar ${obj.cobre} cobres (${q.titulo})` : `${q.titulo}: conversar`;
      add(label, () => this.send(`[${label}]`, { acao: "concluir", missao: qid }), "chip action");
    }
    for (const qid of this.game.offersFor(target.id)) {
      add(`Aceitar: ${this.game.quests[qid].titulo}`, () => this.send(`[Aceita o pedido: ${this.game.quests[qid].titulo}]`, { acao: "aceitar", missao: qid }), "chip action");
    }
    const generic = [
      [`Perguntar sobre ${def.nome.split(" ").pop()}`, `Pergunto a ${def.nome} como vai a vida e o que ${def.titulo.toLowerCase()} faz por aqui.`],
      ["Pedir notícias da capital", `Pergunto a ${def.nome} quais são as novidades e boatos de Cinzas de Alvor.`],
    ];
    if (target.id !== "luna" && this.present.some((a) => a.id === "luna")) generic.push(["Chamar a Luna para a conversa", "Olho para a Luna e puxo ela para a conversa."]);
    for (const [label, text] of generic) add(label, () => this.send(text));
  }

  // ---------------------------------------------------------------------------- abrir / fechar
  open(agent, opts = {}) {
    if (!agent) return;
    this.isOpen = true;
    this.talkingTo = agent;
    const p = this.player.position;
    this.present = this.npcs.presentNear(p, 7.5);
    if (!this.present.includes(agent)) this.present.unshift(agent);
    this.present.sort((a, b) => (a === agent ? -1 : b === agent ? 1 : 0));
    for (const a of this.present) a.beginTalk(p);
    this.renderPills();
    this.setSpeaker(agent.id);
    this.renderThread(agent.id);
    this.renderChips();
    this.player.inputBlocked = true;
    this.player.releasePointer();
    this.hud.setPrompt(null);
    this.el.modal.classList.add("open");
    this.el.modal.setAttribute("aria-hidden", "false");
    this.follow = true;
    this.scrollToBottom();
    setTimeout(() => this.el.input.focus(), 80);
    if (opts.acao) this.send(opts.text || "[...]", opts);
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    for (const a of this.npcs.agents) a.endTalk();
    this.talkingTo = null;
    this.player.inputBlocked = false;
    this.el.modal.classList.remove("open");
    this.el.modal.setAttribute("aria-hidden", "true");
    this.el.input.blur();
  }

  // ---------------------------------------------------------------------------- log
  scrollToBottom() {
    const log = this.el.log;
    this.programmaticScroll = true;
    log.scrollTop = log.scrollHeight;
  }

  // Acompanha o texto sem nunca empurrar o começo da resposta atual para fora da tela
  followText() {
    if (!this.follow) {
      this.updateMore();
      return;
    }
    const log = this.el.log;
    const bottom = log.scrollHeight - log.clientHeight;
    let target = bottom;
    if (this.activeEl) {
      const anchor = this.activeEl.offsetTop - log.offsetTop - 10;
      if (anchor < bottom) {
        target = Math.max(log.scrollTop, anchor);
        if (target < bottom) this.follow = false;
      }
    }
    if (Math.abs(log.scrollTop - target) > 1) {
      this.programmaticScroll = true;
      log.scrollTop = target;
    }
    this.updateMore();
  }

  updateMore() {
    const log = this.el.log;
    const hidden = log.scrollHeight - log.scrollTop - log.clientHeight > CONFIG.ui.autoScrollSlack;
    this.el.more.classList.toggle("show", hidden);
  }

  threadOf(id) {
    if (!this.threads.has(id)) this.threads.set(id, []);
    return this.threads.get(id);
  }

  record(id, role, text) {
    if (id && text) this.threadOf(id).push({ role, text });
  }

  // Redesenha o log com a conversa de um NPC só
  renderThread(id) {
    this.queue = "";
    this.activeEl = null;
    this.el.log.innerHTML = "";
    for (const e of this.threadOf(id)) this.append(e.role, e.text);
    this.follow = true;
    this.scrollToBottom();
    this.updateMore();
  }

  append(role, text, streaming = false) {
    const div = document.createElement("div");
    div.className = `turn-entry ${role === "user" ? "player" : role === "event" ? "event" : "narrator"}`;
    if (streaming) div.classList.add("streaming-cursor");
    div.textContent = role === "event" ? text : stripStateTags(text || "");
    this.el.log.appendChild(div);
    return div;
  }

  applyState(state) {
    if (!state) return;
    this.lastState = state;
    this.game.applyServerState(state);
    this.hud.renderRelation(state);
    if (this.isOpen) {
      if (this.speaker) this.setSpeaker(this.speaker);
      this.renderChips();
    }
  }

  async loadInitial() {
    try {
      const res = await fetch("/api/state");
      const data = await res.json();
      if (!data.ok) return null;
      this.el.log.innerHTML = "";
      this.threads.clear();
      for (const [id, msgs] of Object.entries(data.histories || {})) {
        if (Array.isArray(msgs)) for (const m of msgs) this.record(id, m.role, m.content);
      }
      this.applyState(data.state);
      if (data.motor && data.motor.model) this.el.model.textContent = `(${data.motor.model})`;
      return data;
    } catch (err) {
      console.error("[Alvor] /api/state falhou:", err);
      return null;
    }
  }

  async reset(full) {
    if (this.streaming) return;
    try {
      const res = await fetch("/api/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ full }) });
      const data = await res.json();
      if (!data.ok) return;
      this.queue = "";
      this.activeEl = null;
      this.el.log.innerHTML = "";
      this.threads.clear();
      this.applyState(data.state);
      if (full) this.hud.toast("Nova jornada iniciada — a lenha espera nos fundos da estalagem.");
    } catch (err) {
      console.error("[Alvor] /api/reset falhou:", err);
    }
  }

  handleGameEvent(evt) {
    this.applyState(evt.state);
    if (evt.ok) {
      const gained = Object.entries(evt.gained || {});
      const line = `✦ ${evt.message}${gained.length ? " — " + gained.map(([k, v]) => `${k === "cobre" ? "Cobre" : this.game.items[k] ? this.game.items[k].nome : k} +${v}`).join(", ") : ""}`;
      this.append("event", line);
      this.record(this.talkingTo && this.talkingTo.id, "event", line);
      this.hud.toast(evt.message, "success", gained.length ? gained[0][0] : null);
      this.audio.cue(evt.event === "missao_concluida" || evt.event === "lenha_entregue" ? "quest" : "deliver");
    } else {
      this.append("event", `✖ ${evt.message}`);
      this.record(this.talkingTo && this.talkingTo.id, "event", `✖ ${evt.message}`);
      this.hud.toast(evt.message, "warn");
      this.audio.cue("error");
    }
  }

  // ---------------------------------------------------------------------------- envio + stream
  async send(text, { acao = "", missao = "" } = {}) {
    if (this.streaming || !this.talkingTo) return;
    this.streaming = true;
    this.el.send.disabled = true;
    for (const b of this.el.chips.children) b.disabled = true;
    this.queue = "";
    const npc = this.talkingTo.id;
    this.append("user", text);
    this.record(npc, "user", text);
    const target = this.append("assistant", "", true);
    this.activeEl = target;
    this.follow = true;
    this.scrollToBottom();
    let finalText = "";
    const body = { message: text, npc, cena: this.getScene(this.present) };
    if (acao) Object.assign(body, { acao, missao });
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(body),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() || "";
        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          const raw = line.slice(5).trim();
          if (!raw || raw === "[DONE]") continue;
          let evt;
          try {
            evt = JSON.parse(raw);
          } catch (_) {
            continue;
          }
          if (evt.type === "token" && evt.token) this.queue += evt.token;
          else if (evt.type === "event") {
            this.handleGameEvent(evt);
            this.el.log.appendChild(target);
          } else if (evt.type === "done") {
            finalText = stripStateTags(evt.narration || "");
            this.applyState(evt.state);
          } else if (evt.type === "error") {
            this.queue = "";
            target.textContent = `[Erro na narração: ${evt.error}]`;
            target.classList.remove("streaming-cursor");
            this.activeEl = null;
          }
        }
      }
      if (this.activeEl === target) await this.drain(target, finalText);
      this.record(npc, "assistant", finalText);
    } catch (err) {
      this.queue = "";
      target.textContent = `[Não foi possível comunicar com o servidor: ${err.message}]`;
      target.classList.remove("streaming-cursor");
      if (this.activeEl === target) this.activeEl = null;
    } finally {
      this.streaming = false;
      this.el.send.disabled = false;
      this.renderChips();
      if (this.isOpen) this.el.input.focus();
      this.updateMore();
    }
  }

  drain(target, finalText) {
    return new Promise((resolve) => {
      this.onDrained = () => {
        if (finalText) {
          target.textContent = finalText;
          this.setSpeaker(this.detectSpeaker(finalText));
        }
        target.classList.remove("streaming-cursor");
        this.activeEl = null;
        this.onDrained = null;
        this.followText();
        resolve();
      };
    });
  }

  // Typewriter dirigido pelo loop principal: velocidade cresce com a fila (nunca atrasa o stream)
  update(dt) {
    if (!this.activeEl) return;
    if (this.queue.length === 0) {
      if (this.onDrained) this.onDrained();
      return;
    }
    const cps = CONFIG.ui.typewriterCharsPerSecond * (1 + this.queue.length / 80);
    this.charBudget += dt * cps;
    const n = Math.floor(this.charBudget);
    if (n <= 0) return;
    this.charBudget -= n;
    this.activeEl.textContent += this.queue.slice(0, n);
    this.queue = this.queue.slice(n);
    this.followText();
    const detected = this.detectSpeaker(this.activeEl.textContent);
    if (detected !== this.speaker) this.setSpeaker(detected);
  }
}
