import { CONFIG } from "./config.js";
import { SoundScape } from "./sfx.js";

// Áudio ambiente: síntese no AudioWorklet (thread de áudio), lareira posicional com PannerNode
// (atenuação por distância real) e chuva com filtro passa-baixa quando o jogador está sob telhado.
// O loop de render só agenda alvos de parâmetros (setTargetAtTime), no máximo a cada 100 ms.
// Sons gravados (sfx.js) têm prioridade: fx()/cue() tocam a gravação quando ela existe e a chuva e a
// lareira sintetizadas silenciam quando os loops gravados correspondentes estão carregados.

// Alcance de cada som posicional (refDistance/maxDistance/rolloff do PannerNode)
const FX_SPACE = {
  default: { ref: 2, max: 40, rolloff: 1.2 },
  bell: { ref: 9, max: 220, rolloff: 0.55 },
  gate: { ref: 5, max: 90, rolloff: 0.8 },
  golemRumble: { ref: 6, max: 70, rolloff: 0.9 },
  runePulse: { ref: 4, max: 50, rolloff: 1.0 },
  enemyTelegraph: { ref: 3, max: 35, rolloff: 1.1 },
};

// Registro de sintetizadores (novo som = nova entrada; fx() não muda)
const FX_SYNTHS = {
  // Três batidas secas de nó dos dedos na madeira
  knock(a, out, now) {
    for (let i = 0; i < 3; i++) {
      const t = now + i * 0.19 + (i === 2 ? 0.04 : 0);
      a.burst(out, t, { type: "lowpass", freq: 420, q: 0.7, peak: 0.5, decay: 0.07 });
      a.partial(out, t, 118 + i * 4, 0.35, 0.09);
    }
  },
  doorOpen(a, out, now) {
    a.creak(out, now, 0.55, 34, 52, 0.07);
  },
  doorClose(a, out, now) {
    a.creak(out, now, 0.35, 40, 30, 0.05);
    a.burst(out, now + 0.38, { type: "lowpass", freq: 260, q: 0.8, peak: 0.55, decay: 0.16 });
    a.partial(out, now + 0.38, 72, 0.4, 0.2);
  },
  window(a, out, now) {
    a.creak(out, now, 0.42, 48, 70, 0.05);
    a.burst(out, now + 0.42, { type: "bandpass", freq: 900, q: 1.5, peak: 0.12, decay: 0.05 });
  },
  // Goles e borbulhas: bolhas senoidais com glissando para cima sobre um chiado de água
  water(a, out, now) {
    a.burst(out, now, { type: "bandpass", freq: 1400, q: 0.6, peak: 0.05, attack: 0.08, decay: 0.7 });
    const ctx = a.ctx;
    for (let i = 0; i < 6; i++) {
      const t = now + 0.05 + i * 0.11 + Math.random() * 0.04;
      const osc = ctx.createOscillator();
      const f = 380 + Math.random() * 420;
      osc.frequency.setValueAtTime(f, t);
      osc.frequency.exponentialRampToValueAtTime(f * 1.9, t + 0.06);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
      osc.connect(g).connect(out);
      osc.start(t);
      osc.stop(t + 0.1);
    }
  },
  // Sino de bronze: parciais inarmônicos (hum, prime, terça menor, quinta, nominal...) com
  // decaimentos diferentes (os agudos morrem antes) e pares levemente desafinados (batimento)
  bell(a, out, now) {
    const base = 233;
    const partials = [
      [0.5, 0.22, 7.5], [1.0, 0.3, 5.5], [1.183, 0.2, 4.2], [1.506, 0.12, 3.2],
      [2.0, 0.18, 2.6], [2.514, 0.08, 1.8], [2.662, 0.07, 1.6], [3.011, 0.06, 1.2], [4.166, 0.04, 0.8],
    ];
    for (const [ratio, peak, decay] of partials) {
      a.partial(out, now, base * ratio, peak, decay, "sine", 0.002);
      a.partial(out, now, base * ratio * 1.0025, peak * 0.4, decay * 0.9, "sine", 0.002);
    }
    a.burst(out, now, { type: "bandpass", freq: 2600, q: 2, peak: 0.25, attack: 0.001, decay: 0.05 });
  },
  // Alavanca: catraca de ferro (cliques metálicos) e o gemido grave do portão
  lever(a, out, now) {
    for (let i = 0; i < 10; i++) {
      const t = now + i * 0.11;
      a.burst(out, t, { type: "highpass", freq: 2200, q: 0.7, peak: 0.12, decay: 0.03 });
      a.partial(out, t, 1750 + (i % 2) * 140, 0.05, 0.04, "triangle");
    }
  },
  gate(a, out, now) {
    a.burst(out, now, { type: "lowpass", freq: 140, q: 0.9, peak: 0.35, attack: 0.25, decay: 2.4 });
    a.creak(out, now + 0.1, 2.0, 22, 30, 0.05);
    a.burst(out, now + 2.6, { type: "lowpass", freq: 200, q: 1, peak: 0.5, decay: 0.3 });
  },
  chest(a, out, now) {
    a.creak(out, now, 0.4, 44, 64, 0.06);
    a.burst(out, now + 0.4, { type: "lowpass", freq: 500, q: 1, peak: 0.25, decay: 0.08 });
  },
  // Mãos perto do fogo: sopro morno
  warm(a, out, now) {
    a.burst(out, now, { type: "lowpass", freq: 700, q: 0.5, peak: 0.12, attack: 0.25, decay: 0.7 });
  },
  sit(a, out, now) {
    a.burst(out, now, { type: "lowpass", freq: 320, q: 0.7, peak: 0.25, decay: 0.12 });
    a.creak(out, now + 0.05, 0.25, 50, 58, 0.03);
  },

  // ---- Combate (combat.js e enemies.js chamam pelo nome; contrato de integração) -------------------
  // Lâmina cortando o ar: ruído com banda deslizando de grave a agudo
  swordSwing(a, out, now) {
    a.whoosh(out, now, 0.2, 500, 2600, 0.22);
  },
  // Aço em carne/couro: estalo metálico curto (parciais inarmônicos) sobre um baque
  swordHit(a, out, now) {
    a.burst(out, now, { type: "highpass", freq: 2400, q: 0.8, peak: 0.25, decay: 0.05 });
    a.burst(out, now, { type: "lowpass", freq: 420, q: 0.9, peak: 0.45, decay: 0.12 });
    a.partial(out, now, 1240, 0.09, 0.18, "triangle", 0.002);
    a.partial(out, now, 1873, 0.06, 0.12, "sine", 0.002);
    a.partial(out, now, 2961, 0.04, 0.08, "sine", 0.002);
  },
  // Madeira do cajado: "toc" oco
  staffHit(a, out, now) {
    a.burst(out, now, { type: "lowpass", freq: 900, q: 1.2, peak: 0.45, decay: 0.09 });
    a.partial(out, now, 210, 0.3, 0.12, "triangle", 0.002);
    a.partial(out, now, 318, 0.14, 0.08, "sine", 0.002);
  },
  // Disparo arcano: glissando ascendente com brilho cristalino
  arcaneCast(a, out, now) {
    a.sweep(out, now, 320, 1250, 0.12, 0.22, "sine");
    a.sweep(out, now + 0.02, 640, 2500, 0.05, 0.2, "triangle");
    a.whoosh(out, now, 0.22, 1200, 4200, 0.08);
  },
  arcaneHit(a, out, now) {
    a.burst(out, now, { type: "bandpass", freq: 2200, q: 1.1, peak: 0.28, decay: 0.12 });
    a.sweep(out, now, 950, 180, 0.14, 0.25, "sine");
    a.partial(out, now + 0.01, 1760, 0.05, 0.3, "sine");
    a.partial(out, now + 0.03, 2637, 0.035, 0.25, "sine");
  },
  // Pulso rúnico: queda grave de pressão + anel harmônico que reverbera
  runePulse(a, out, now) {
    a.sweep(out, now, 150, 42, 0.4, 0.9, "sine");
    a.burst(out, now, { type: "lowpass", freq: 320, q: 0.8, peak: 0.45, attack: 0.01, decay: 0.6 });
    a.partial(out, now + 0.05, 220, 0.08, 1.2, "sine", 0.02);
    a.partial(out, now + 0.05, 331, 0.06, 1.0, "sine", 0.02);
    a.partial(out, now + 0.05, 441.5, 0.04, 0.8, "sine", 0.02);
  },
  // Luz restauradora: arpejo maior luminoso e um sopro de ar
  healCast(a, out, now) {
    const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
    for (let i = 0; i < notes.length; i++) a.partial(out, now + i * 0.08, notes[i], 0.08, 0.9 - i * 0.1, "sine", 0.01);
    a.burst(out, now, { type: "highpass", freq: 3000, q: 0.5, peak: 0.06, attack: 0.2, decay: 0.8 });
  },
  dodge(a, out, now) {
    a.whoosh(out, now, 0.24, 1600, 380, 0.16);
    a.burst(out, now + 0.18, { type: "lowpass", freq: 600, q: 0.7, peak: 0.18, decay: 0.08 });
  },
  // Jogador ferido: baque surdo e um gemido curto
  playerHurt(a, out, now) {
    a.burst(out, now, { type: "lowpass", freq: 260, q: 1, peak: 0.55, decay: 0.14 });
    a.sweep(out, now + 0.01, 280, 150, 0.09, 0.2, "sawtooth", 900);
  },
  // Aviso antes do golpe inimigo: chiado que sobe (dá tempo de esquivar)
  enemyTelegraph(a, out, now) {
    a.sweep(out, now, 180, 420, 0.06, 0.32, "square", 1400);
    a.whoosh(out, now, 0.3, 400, 1600, 0.05);
  },
  enemyAttack(a, out, now) {
    a.whoosh(out, now, 0.16, 700, 2000, 0.14);
    a.burst(out, now + 0.1, { type: "lowpass", freq: 380, q: 0.9, peak: 0.35, decay: 0.1 });
  },
  enemyDeath(a, out, now) {
    a.sweep(out, now, 380, 60, 0.12, 0.6, "sawtooth", 700);
    a.burst(out, now + 0.05, { type: "lowpass", freq: 260, q: 0.8, peak: 0.4, attack: 0.02, decay: 0.5 });
  },
  // Slime: plop gelatinoso (glissando rápido para cima) e bolhas
  slimeSquish(a, out, now) {
    a.sweep(out, now, 170, 560, 0.16, 0.12, "sine");
    a.burst(out, now, { type: "lowpass", freq: 650, q: 2.5, peak: 0.22, decay: 0.15 });
    a.sweep(out, now + 0.1, 300, 700, 0.06, 0.06, "sine");
  },
  // Javali: três roncos curtos (serra grave filtrada)
  boarGrunt(a, out, now) {
    for (let i = 0; i < 3; i++) a.sweep(out, now + i * 0.11, 125 - i * 8, 82, 0.13, 0.09, "sawtooth", 520);
  },
  // Lobo: rosnado grave com tremor (pulsos de amplitude) e um pouco de ar
  wolfGrowl(a, out, now) {
    for (let i = 0; i < 9; i++) a.sweep(out, now + i * 0.075, 92 + (i % 3) * 6, 80, 0.09, 0.07, "sawtooth", 600);
    a.burst(out, now, { type: "bandpass", freq: 700, q: 0.8, peak: 0.05, attack: 0.08, decay: 0.6 });
  },
  // Esqueleto: chocalho de ossos (cliques secos irregulares)
  boneRattle(a, out, now) {
    for (let i = 0; i < 8; i++) {
      const t = now + i * 0.045 + Math.random() * 0.02;
      a.burst(out, t, { type: "bandpass", freq: 1800 + Math.random() * 1400, q: 3, peak: 0.12, decay: 0.025 });
      a.partial(out, t, 900 + Math.random() * 700, 0.03, 0.03, "triangle", 0.001);
    }
  },
  // Guardião rúnico: ronco de pedra muito grave
  golemRumble(a, out, now) {
    a.burst(out, now, { type: "lowpass", freq: 130, q: 0.9, peak: 0.5, attack: 0.18, decay: 1.4 });
    a.sweep(out, now, 62, 34, 0.25, 1.3, "sine");
    a.burst(out, now + 0.25, { type: "bandpass", freq: 500, q: 1.5, peak: 0.08, attack: 0.05, decay: 0.5 });
  },
  // Boneco de treino: palha e madeira
  dummyHit(a, out, now) {
    a.burst(out, now, { type: "lowpass", freq: 760, q: 0.9, peak: 0.38, decay: 0.08 });
    a.burst(out, now, { type: "bandpass", freq: 3200, q: 0.7, peak: 0.07, decay: 0.12 });
    a.partial(out, now, 168, 0.2, 0.1, "triangle", 0.002);
  },
};

export class AmbientAudio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.starting = null;
    this.accum = 0;
    this.firePosition = null;
    this.targets = new Map();
    this.noiseBuffer = null;
    this.scape = null;
    this.refs = null;
  }

  // Mundo, jogador, NPCs e relógio para a paisagem sonora (pode chegar antes ou depois do start())
  attach(refs) {
    this.refs = refs;
    if (this.scape) this.scape.attach(refs);
  }

  setFirePosition(vec3) {
    this.firePosition = vec3;
  }

  // Chamado no primeiro gesto do usuário (política de autoplay)
  start() {
    if (this.starting) return this.starting;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return Promise.resolve();
    this.ctx = new Ctx();
    this.starting = this.ctx.audioWorklet
      .addModule(CONFIG.assets.audioWorklet)
      .then(() => this.buildGraph())
      .catch((err) => console.warn("[Alvor] Áudio ambiente indisponível:", err));
    return this.starting;
  }

  resume() {
    if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
  }

  buildGraph() {
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.85;
    this.master.connect(ctx.destination);

    const rain = new AudioWorkletNode(ctx, "alvor-rain", { numberOfInputs: 0, outputChannelCount: [1] });
    this.rainFilter = ctx.createBiquadFilter();
    this.rainFilter.type = "lowpass";
    this.rainFilter.frequency.value = 4200;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    rain.connect(this.rainFilter).connect(this.rainGain).connect(this.master);

    const fire = new AudioWorkletNode(ctx, "alvor-fire", { numberOfInputs: 0, outputChannelCount: [1] });
    this.fireFilter = ctx.createBiquadFilter();
    this.fireFilter.type = "lowpass";
    this.fireFilter.frequency.value = 2600;
    this.firePanner = ctx.createPanner();
    this.firePanner.panningModel = "equalpower";
    this.firePanner.distanceModel = "inverse";
    this.firePanner.refDistance = 1.4;
    this.firePanner.maxDistance = 30;
    this.firePanner.rolloffFactor = 1.6;
    if (this.firePosition) {
      this.firePanner.positionX.value = this.firePosition.x;
      this.firePanner.positionY.value = this.firePosition.y;
      this.firePanner.positionZ.value = this.firePosition.z;
    }
    this.fireGain = ctx.createGain();
    this.fireGain.gain.value = 0;
    fire.connect(this.fireFilter).connect(this.firePanner).connect(this.fireGain).connect(this.master);
    this.ready = true;
    this.scape = new SoundScape(this);
    if (this.refs) this.scape.attach(this.refs);
    this.scape.load(CONFIG.assets.sfx).catch((err) => console.warn("[Alvor] Manifesto de SFX indisponível:", err));
  }

  // Sinais curtos de gameplay (recolher lenha, entregar) sintetizados na hora
  cue(kind) {
    if (!this.ready) return;
    if (this.scape && this.scape.playCue(kind)) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const table = {
      deliver: [523.25, 659.25, 783.99],
      quest: [392, 523.25, 659.25, 1046.5],
      coin: [1318.5, 1760],
      use: [440, 554.37],
      pickup: [196, 147],
      error: [146.8, 110],
    };
    const notes = table[kind] || table.pickup;
    const soft = kind !== "pickup" && kind !== "error";
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = soft ? "triangle" : "square";
      osc.frequency.value = freq;
      const t0 = now + i * (soft ? 0.09 : 0.06);
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(soft ? 0.1 : 0.06, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + (soft ? 0.45 : 0.12));
      osc.connect(gain).connect(this.master);
      osc.start(t0);
      osc.stop(t0 + 0.6);
    });
  }

  // --- Sons do mundo (portas, janelas, água, sino, corrente) -----------------------------------
  // Sintetizados por evento (nunca por frame). Com posição, passam por um PannerNode próprio
  // (atenuação real pela distância até o ouvinte, que update() mantém na câmera).
  fx(kind, pos = null, gain = 1) {
    if (!this.ready) return;
    const space = FX_SPACE[kind] || FX_SPACE.default;
    if (this.scape && this.scape.playFx(kind, pos, gain, space)) return;
    const synth = FX_SYNTHS[kind];
    if (!synth) return;
    const out = this.ctx.createGain();
    out.gain.value = gain;
    this.route(out, pos, space);
    synth(this, out, this.ctx.currentTime);
  }

  // Liga um nó ao master, passando por um PannerNode quando há posição
  route(node, pos, space = null) {
    const ctx = this.ctx;
    if (!pos || !ctx.createPanner) {
      node.connect(this.master);
      return;
    }
    const spec = space || FX_SPACE.default;
    const pan = ctx.createPanner();
    pan.panningModel = "equalpower";
    pan.distanceModel = "inverse";
    pan.refDistance = spec.ref;
    pan.maxDistance = spec.max;
    pan.rolloffFactor = spec.rolloff;
    if (pan.positionX) {
      pan.positionX.value = pos.x;
      pan.positionY.value = pos.y;
      pan.positionZ.value = pos.z;
    } else {
      pan.setPosition(pos.x, pos.y, pos.z);
    }
    node.connect(pan).connect(this.master);
  }

  // Ruído branco reaproveitado (2 s, mono) por todos os sons percussivos
  noise() {
    if (!this.noiseBuffer) {
      const ctx = this.ctx;
      const len = ctx.sampleRate * 2;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuffer = buf;
    }
    return this.noiseBuffer;
  }

  // Rajada de ruído filtrado com envelope percussivo
  burst(out, t0, { type = "bandpass", freq = 800, q = 1, peak = 0.3, attack = 0.003, decay = 0.08 }) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise();
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
    src.connect(f).connect(g).connect(out);
    src.start(t0, Math.random() * 1.5);
    src.stop(t0 + attack + decay + 0.05);
  }

  // Parcial senoidal com decaimento exponencial
  partial(out, t0, freq, peak, decay, type = "sine", attack = 0.004) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
    osc.connect(g).connect(out);
    osc.start(t0);
    osc.stop(t0 + attack + decay + 0.05);
  }

  /**
   * Oscilador com glissando exponencial de f0 a f1 (opcionalmente por um passa-baixa).
   * @param {AudioNode} out
   * @param {number} t0
   * @param {number} f0 Hz
   * @param {number} f1 Hz
   * @param {number} peak ganho de pico
   * @param {number} dur s
   * @param {OscillatorType} [type="sine"]
   * @param {number} [lowpass=0] Hz (0 = sem filtro)
   */
  sweep(out, t0, f0, f1, peak, dur, type = "sine", lowpass = 0) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(0.012, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    if (lowpass > 0) {
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = lowpass;
      osc.connect(f).connect(g).connect(out);
    } else {
      osc.connect(g).connect(out);
    }
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  /**
   * Ruído numa banda que desliza de f0 a f1 (deslocamento de ar: golpe, esquiva).
   * @param {AudioNode} out
   * @param {number} t0
   * @param {number} dur s
   * @param {number} f0 Hz
   * @param {number} f1 Hz
   * @param {number} peak
   */
  whoosh(out, t0, dur, f0, f1, peak) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise();
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.Q.value = 1.4;
    f.frequency.setValueAtTime(f0, t0);
    f.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + dur * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(out);
    src.start(t0, Math.random() * 1.5);
    src.stop(t0 + dur + 0.05);
  }

  // Rangido de madeira: atrito "gruda-solta" (pulsos rápidos) num filtro ressonante que desliza
  creak(out, t0, dur, f0, f1, peak) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.linearRampToValueAtTime(f1, t0 + dur * 0.6);
    osc.frequency.linearRampToValueAtTime(f0 * 0.8, t0 + dur);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(700, t0);
    bp.frequency.linearRampToValueAtTime(1300, t0 + dur);
    bp.Q.value = 6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.05);
    g.gain.setValueAtTime(peak, t0 + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(bp).connect(g).connect(out);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  update(dt, camera, zone, underRoof, rain = 1) {
    if (!this.ready || this.ctx.state !== "running") return;
    this.accum += dt;
    if (this.accum < 0.1) return;
    const tick = this.accum;
    this.accum = 0;
    const now = this.ctx.currentTime;
    const listener = this.ctx.listener;
    const p = camera.position;
    const e = camera.matrixWorld.elements;
    // Ouvinte por valor direto: agendar setTargetAtTime a cada atualização empilharia eventos na
    // timeline do AudioParam sem limite (cada evento fica guardado até o contexto ser fechado).
    if (listener.positionX) {
      listener.positionX.value = p.x;
      listener.positionY.value = p.y;
      listener.positionZ.value = p.z;
      listener.forwardX.value = -e[8];
      listener.forwardY.value = -e[9];
      listener.forwardZ.value = -e[10];
      listener.upX.value = e[4];
      listener.upY.value = e[5];
      listener.upZ.value = e[6];
    } else {
      listener.setPosition(p.x, p.y, p.z);
      listener.setOrientation(-e[8], -e[9], -e[10], e[4], e[5], e[6]);
    }
    const indoors = zone.building || underRoof;
    // Intensidade da chuva vem do clima; arredondada para não reagendar a cada décimo de segundo
    const rainLevel = Math.round(rain * 20) / 20;
    const scape = this.scape;
    const recordedRain = scape && scape.has("amb_chuva_rua");
    const recordedFire = scape && scape.has("amb_lareira");
    this.glide("rainGain", this.rainGain.gain, recordedRain ? 0 : rainLevel * (indoors ? 0.1 : 0.34), now, 0.6);
    this.glide("rainFilter", this.rainFilter.frequency, indoors ? 620 : 4200, now, 0.35);
    // Lareira: o PannerNode atenua pela distância; fora da estalagem as paredes abafam o som
    const inInn = zone.interiorOf === "Inn";
    this.glide("fireGain", this.fireGain.gain, recordedFire ? 0 : inInn ? 1.0 : 0.45, now, 0.3);
    this.glide("fireFilter", this.fireFilter.frequency, inInn ? 2600 : 520, now, 0.3);
    if (scape) scape.update(tick, zone, underRoof, rain);
  }

  // Reagenda só quando o alvo muda e limpa o que estava pendente: a timeline nunca cresce
  glide(key, param, value, now, timeConstant) {
    if (this.targets.get(key) === value) return;
    this.targets.set(key, value);
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.setTargetAtTime(value, now, timeConstant);
  }
}
