// Sintetizadores procedurais rodando na thread de áudio (AudioWorklet): nada aqui toca a thread de render.

class RainProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.b0 = 0; this.b1 = 0; this.b2 = 0;
    this.dropEnv = 0; this.dropFreq = 0; this.dropPhase = 0;
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    for (let i = 0; i < out.length; i++) {
      const white = Math.random() * 2 - 1;
      // Ruído rosa (filtro de Paul Kellet, versão econômica): chiado contínuo de chuva
      this.b0 = 0.99765 * this.b0 + white * 0.099046;
      this.b1 = 0.963 * this.b1 + white * 0.2965164;
      this.b2 = 0.57 * this.b2 + white * 1.0526913;
      const pink = (this.b0 + this.b1 + this.b2 + white * 0.1848) * 0.11;
      // Gotas individuais batendo em poças e telhas: senoide curta com envelope exponencial
      if (Math.random() < 0.0009) {
        this.dropEnv = 0.25 + Math.random() * 0.35;
        this.dropFreq = (900 + Math.random() * 2600) / sampleRate;
        this.dropPhase = 0;
      }
      let drop = 0;
      if (this.dropEnv > 1e-4) {
        this.dropPhase += this.dropFreq;
        drop = Math.sin(this.dropPhase * 6.2831853) * this.dropEnv;
        this.dropEnv *= 0.9965;
      }
      out[i] = pink + drop * 0.35;
    }
    return true;
  }
}

class FireProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.rumble = 0;
    this.crackleEnv = 0;
    this.crackleAmp = 0;
    this.hiss = 0;
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    for (let i = 0; i < out.length; i++) {
      const white = Math.random() * 2 - 1;
      this.rumble = this.rumble * 0.985 + white * 0.015;
      this.hiss = this.hiss * 0.6 + white * 0.4;
      if (Math.random() < 0.00042) {
        this.crackleEnv = 1;
        this.crackleAmp = 0.35 + Math.random() * 0.65;
      }
      let pop = 0;
      if (this.crackleEnv > 5e-4) {
        pop = (Math.random() * 2 - 1) * this.crackleAmp * this.crackleEnv;
        this.crackleEnv *= 0.955;
      }
      out[i] = this.rumble * 2.6 + pop * 0.8 + this.hiss * 0.012;
    }
    return true;
  }
}

registerProcessor("alvor-rain", RainProcessor);
registerProcessor("alvor-fire", FireProcessor);
