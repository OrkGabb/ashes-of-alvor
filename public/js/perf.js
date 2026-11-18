import { CONFIG, QUALITY } from "./config.js";

// Monitor de desempenho: calibração no boot, resolução adaptativa e cadência do mapa de sombras.
// Expõe window.alvorPerf para inspeção.
//
// Medida de custo: quando a GPU oferece EXT_disjoint_timer_query_webgl2, o tempo de GPU de cada
// quadro amostrado é lido de forma assíncrona (sem travar a fila). Sem a extensão, cai na sonda
// antiga (readPixels), que no ANGLE/D3D11 superestima: cada sincronização custa alguns ms fixos.
// O FPS do requestAnimationFrame não serve para adaptar: com a janela ocluída o navegador o
// limita a 30 ou 1 FPS mesmo com a GPU ociosa.

// Orçamento vem do preset de qualidade: "alta" aceita ~40 fps, "desempenho" mira 60 fps
const FRAME_BUDGET_MS = (QUALITY.gpuHighMs + QUALITY.gpuLowMs) / 2;
const FIXED_OVERHEAD_MS = 1.0;
const PROBE_EVERY_FRAMES = 180;
const QUERY_EVERY_FRAMES = 4;
const GPU_HIGH_MS = QUALITY.gpuHighMs;
const GPU_LOW_MS = QUALITY.gpuLowMs;
const ADAPT_EVERY_S = 1.5;
// Sobrecarga grave (p75 acima disso x limite): desce já na primeira janela, ainda em um passo só
const SEVERE_FACTOR = 1.5;

function ascending(a, b) {
  return a - b;
}

/**
 * Piso da resolução adaptativa: nunca abaixo de CONFIG.render.minPixelRatio nem de
 * minFractionOfCap x teto, e nunca acima do teto.
 * @param {number} cap teto efetivo = min(DPR nativo, QUALITY.maxPixelRatio)
 * @param {{minPixelRatio: number, minFractionOfCap: number}} cfg
 * @returns {number}
 */
export function floorDpr(cap, cfg) {
  return Math.min(cap, Math.max(cfg.minPixelRatio, cfg.minFractionOfCap * cap));
}

/**
 * Um passo da escala adaptativa com histerese. Muta os contadores de state (over/under) e devolve o
 * próximo DPR (arredondado a 0,01 e preso em [floor, cap]). Nunca move mais que um passo por chamada.
 * @param {{dpr: number, over: number, under: number}} state
 * @param {number} gpuMs custo medido (p75) da janela
 * @param {number} highMs acima disso a janela conta como "acima do orçamento"
 * @param {number} lowMs abaixo disso a janela conta como "folga"
 * @param {number} floor
 * @param {number} cap
 * @param {{dprStepDown: number, dprStepUp: number, dprDownAfter: number, dprUpAfter: number}} cfg
 * @returns {number}
 */
export function adaptiveDprStep(state, gpuMs, highMs, lowMs, floor, cap, cfg) {
  if (gpuMs > highMs) {
    state.over += gpuMs > highMs * SEVERE_FACTOR ? cfg.dprDownAfter : 1;
    state.under = 0;
  } else if (gpuMs < lowMs) {
    state.under++;
    state.over = 0;
  } else {
    state.over = 0;
    state.under = 0;
  }
  let next = state.dpr;
  if (state.over >= cfg.dprDownAfter) {
    next -= cfg.dprStepDown;
    state.over = 0;
  } else if (state.under >= cfg.dprUpAfter) {
    next += cfg.dprStepUp;
    state.under = 0;
  }
  next = Math.round(next * 100) / 100;
  return Math.max(floor, Math.min(cap, next));
}

export class PerfMonitor {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;
    this.fps = 60;
    this.windowTime = 0;
    this.windowFrames = 0;
    this.dpr = renderer.getPixelRatio();
    this.shadowEvery = 1;
    this.frameIndex = 0;
    this.overlay = document.getElementById("perf-overlay");
    this.overlayVisible = false;
    this.probing = false;
    this.probeStart = 0;
    this.probePixel = new Uint8Array(4);
    this.gpuMs = 0;
    const gl = renderer.getContext();
    this.timer = gl.getExtension("EXT_disjoint_timer_query_webgl2");
    this.pending = [];
    this.activeQuery = null;
    this.samples = [];
    this.adaptTimer = 0;
    this.hyst = { dpr: this.dpr, over: 0, under: 0 };
    this.stats = { fps: 60, dpr: this.dpr, drawCalls: 0, triangles: 0, pointLights: 0, shadowEvery: 1, frameMs: 16.7, calibratedMs: 0, gpuTier: "?", gpuTimer: Boolean(this.timer) };
    window.alvorPerf = this.stats;
  }

  // Mede quadros reais (sincronizados com readPixels, amortizados em vários quadros) na resolução
  // nativa e escolhe DPR, cadência de sombra e quantidade de PointLights para caber no orçamento.
  calibrate(scene, camera, atmosphere) {
    const r = this.renderer;
    const gl = r.getContext();
    const px = new Uint8Array(4);
    r.setPixelRatio(1);
    r.compile(scene, camera);
    const measure = (frames) => {
      // Aquecimento: primeiros quadros pagam upload de texturas e programas; não entram na medida
      for (let i = 0; i < 6; i++) r.render(scene, camera);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) {
        // Mesma cadência de sombra do jogo no preset atual
        r.shadowMap.needsUpdate = i % this.shadowEvery === 0;
        r.render(scene, camera);
      }
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return (performance.now() - t0) / frames;
    };
    // Slots de luz e cadência de sombra vêm do preset (contagem fixa: shader não recompila em jogo);
    // a escolha das luzes pelo jogador mantém a lareira acesa em qualquer preset
    atmosphere.setLightSlots(QUALITY.lightSlots);
    this.shadowEvery = QUALITY.shadowEvery;
    r.compile(scene, camera);
    const ms = measure(12);
    const weak = ms > 8;
    const msAfter = ms;
    const perPixel = Math.max(1e-9, (msAfter - FIXED_OVERHEAD_MS) / (r.domElement.width * r.domElement.height));
    const cssPixels = window.innerWidth * window.innerHeight;
    const ideal = Math.sqrt((FRAME_BUDGET_MS - FIXED_OVERHEAD_MS) / perPixel / cssPixels);
    const cap = this.capDpr();
    this.dpr = Math.max(floorDpr(cap, CONFIG.render), Math.min(cap, Math.round(ideal * 20) / 20));
    r.setPixelRatio(this.dpr);
    this.hyst.dpr = this.dpr;
    this.hyst.over = 0;
    this.hyst.under = 0;
    this.gpuMs = 0;
    Object.assign(this.stats, { calibratedMs: Math.round(msAfter * 100) / 100, gpuTier: weak ? "integrada/fraca" : "forte", quality: QUALITY.label, dpr: this.dpr, shadowEvery: this.shadowEvery });
    return this.stats;
  }

  toggleOverlay() {
    this.overlayVisible = !this.overlayVisible;
    if (this.overlay) this.overlay.hidden = !this.overlayVisible;
  }

  beforeRender() {
    this.frameIndex++;
    this.renderer.shadowMap.needsUpdate = this.frameIndex % this.shadowEvery === 0;
    if (this.timer) {
      if (this.frameIndex % QUERY_EVERY_FRAMES === 0 && this.pending.length < 4) {
        const gl = this.renderer.getContext();
        this.activeQuery = gl.createQuery();
        gl.beginQuery(this.timer.TIME_ELAPSED_EXT, this.activeQuery);
      }
      return;
    }
    this.probing = this.frameIndex % PROBE_EVERY_FRAMES === 0;
    if (this.probing) {
      // Esvazia a fila da GPU antes de cronometrar (senão soma quadros anteriores ainda pendentes)
      const gl = this.renderer.getContext();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.probePixel);
      this.probeStart = performance.now();
    }
  }

  // Coleta resultados prontos sem bloquear (os mais antigos ficam prontos 1-3 quadros depois)
  collectQueries() {
    const gl = this.renderer.getContext();
    const disjoint = gl.getParameter(this.timer.GPU_DISJOINT_EXT);
    while (this.pending.length) {
      const q = this.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
      gl.deleteQuery(q);
      this.pending.shift();
      if (!disjoint) this.samples.push(ns / 1e6);
    }
  }

  /** @returns {number} teto do DPR: nativo limitado pelo preset */
  capDpr() {
    return Math.min(window.devicePixelRatio || 1, QUALITY.maxPixelRatio);
  }

  /** @param {number} value DPR desejado (preso entre o piso e o teto) */
  setDpr(value) {
    const cap = this.capDpr();
    const next = Math.max(floorDpr(cap, CONFIG.render), Math.min(cap, Math.round(value * 100) / 100));
    this.hyst.dpr = next;
    if (Math.abs(next - this.dpr) < 1e-3) return;
    this.dpr = next;
    this.renderer.setPixelRatio(next);
  }

  /**
   * Aplica um passo com histerese a partir do custo medido.
   * @param {number} gpuMs
   * @param {number} highMs
   * @param {number} lowMs
   */
  stepDpr(gpuMs, highMs, lowMs) {
    const cap = this.capDpr();
    this.hyst.dpr = this.dpr;
    this.setDpr(adaptiveDprStep(this.hyst, gpuMs, highMs, lowMs, floorDpr(cap, CONFIG.render), cap, CONFIG.render));
  }

  adapt(dt) {
    this.adaptTimer += dt;
    if (this.adaptTimer < ADAPT_EVERY_S || this.samples.length < 6) return;
    this.adaptTimer = 0;
    const sorted = this.samples.sort(ascending);
    // Percentil 75: picos isolados (troca de luz, compilação) não derrubam a resolução
    const p75 = sorted[Math.floor(sorted.length * 0.75)];
    this.samples.length = 0;
    this.gpuMs = p75;
    // Passos pequenos com histerese (antes: queda proporcional de uma vez até o piso de 0,6)
    this.stepDpr(p75, GPU_HIGH_MS, GPU_LOW_MS);
  }

  probe() {
    const gl = this.renderer.getContext();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.probePixel);
    const ms = performance.now() - this.probeStart;
    this.gpuMs = this.gpuMs === 0 ? ms : this.gpuMs + (ms - this.gpuMs) * 0.5;
    this.stepDpr(this.gpuMs, FRAME_BUDGET_MS * 1.3, FRAME_BUDGET_MS * 0.6);
  }

  afterRender(dt) {
    const info = this.renderer.info.render;
    this.stats.drawCalls = info.calls;
    this.stats.triangles = info.triangles;
    if (this.timer) {
      if (this.activeQuery) {
        this.renderer.getContext().endQuery(this.timer.TIME_ELAPSED_EXT);
        this.pending.push(this.activeQuery);
        this.activeQuery = null;
      }
      this.collectQueries();
      this.adapt(dt);
    } else if (this.probing) {
      this.probe();
    }
    this.windowTime += dt;
    this.windowFrames++;
    if (this.windowTime < 2) return;
    this.fps = this.windowFrames / this.windowTime;
    this.windowTime = 0;
    this.windowFrames = 0;
    let lights = 0;
    this.scene.traverseVisible((o) => {
      if (o.isPointLight) lights++;
    });
    Object.assign(this.stats, {
      fps: Math.round(this.fps * 10) / 10,
      dpr: this.dpr,
      pointLights: lights,
      shadowEvery: this.shadowEvery,
      frameMs: Math.round(this.gpuMs * 100) / 100,
    });
    if (this.overlayVisible && this.overlay) {
      this.overlay.textContent = `${this.stats.fps} FPS · GPU ${this.stats.frameMs} ms/quadro${this.timer ? " (timer)" : " (sonda)"}
${this.stats.drawCalls} draw calls · ${this.stats.triangles} tris
PointLights ${lights} · DPR ${this.dpr.toFixed(2)} · sombra 1/${this.shadowEvery} · qualidade ${QUALITY.label} (F4)
CPU: npcs ${window.alvorProfile ? window.alvorProfile.npcs.toFixed(2) : "?"} ms · render ${window.alvorProfile ? window.alvorProfile.render.toFixed(2) : "?"} ms`;
    }
  }
}
