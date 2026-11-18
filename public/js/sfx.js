import { containsXZ } from "./world.js";

// Paisagem sonora gravada (public/data/sfx.json -> public/audio/sfx/<id>[_N].mp3, gerados por tools/gen_sfx.py).
// Camadas, todas guiadas pelo manifesto (som novo = entrada nova no JSON, este arquivo não muda):
//  - leitos: loops de fundo misturados por zona, hora, clima e interior;
//  - emissores: loops presos a um ponto (lareiras, forja, chafarizes, moinho) com PannerNode próprio,
//    ligados só quando o ouvinte está ao alcance e abafados quando há parede entre os dois;
//  - pontuais: sons avulsos sorteados de tempos em tempos (pássaros, animais, trovão, martelo da forja),
//    ou nas horas cheias (sino do campanário);
//  - passos do jogador e dos NPCs próximos, recortados por detecção de ataque em gravações de vários passos.
// Cada som pode ter variantes ("variantes": N); cada disparo sorteia uma. Som que ainda não existe em disco
// simplesmente não toca, e audio.js cai no sintetizador antigo.
// Tudo roda no tick de 100 ms do AmbientAudio; nenhuma closure é criada por frame.

const LOAD_CONCURRENCY = 6;
const MUFFLE_HZ = 650;
const OPEN_HZ = 20000;
const BELL_GAP = 2.4;
const WALL_GAIN = 0.3; // som do outro lado de uma parede: abafado (passa-baixa) e a 30% do volume

function rand(a, b) {
  return a + Math.random() * (b - a);
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function inHours(hour, range) {
  const [a, b] = range;
  return a <= b ? hour >= a && hour < b : hour >= a || hour < b;
}

// Mesma regra de nomes do tools/gen_sfx.py: <id>, <id>_2, ..., <id>_N
function variantNames(id, spec) {
  const names = [id];
  for (let k = 2; k <= (spec.variantes || 1); k++) names.push(`${id}_${k}`);
  return names;
}

// Ataques de uma gravação de passos: envelope de 5 ms, picos acima de 30% do máximo, 180 ms de intervalo
// mínimo. Cada recorte vai de 8 ms antes do ataque até o próximo (no máximo 380 ms).
function detectSlices(buffer) {
  const data = buffer.getChannelData(0);
  const win = Math.max(1, Math.floor(buffer.sampleRate * 0.005));
  const env = new Float32Array(Math.floor(data.length / win));
  let max = 0;
  for (let i = 0; i < env.length; i++) {
    let s = 0;
    for (let j = i * win, end = j + win; j < end; j++) s += Math.abs(data[j]);
    env[i] = s / win;
    if (env[i] > max) max = env[i];
  }
  const threshold = max * 0.3;
  const minGap = Math.floor(0.18 / 0.005);
  const onsets = [];
  let last = -minGap;
  for (let i = 1; i < env.length; i++) {
    if (env[i] >= threshold && env[i - 1] < threshold && i - last >= minGap) {
      onsets.push(i * 0.005);
      last = i;
    }
  }
  const slices = [];
  for (let k = 0; k < onsets.length; k++) {
    const start = Math.max(0, onsets[k] - 0.008);
    const next = k + 1 < onsets.length ? onsets[k + 1] - 0.008 : buffer.duration;
    slices.push([start, Math.min(next, start + 0.38) - start]);
  }
  return slices;
}

export class SoundScape {
  constructor(audio) {
    this.audio = audio;
    this.ctx = audio.ctx;
    this.manifest = null;
    this.buffers = new Map(); // id -> AudioBuffer[] (variantes carregadas)
    this.slices = new Map(); // id -> [variante, início, duração][]
    this.beds = [];
    this.emitters = [];
    this.spots = [];
    this.world = null;
    this.player = null;
    this.npcs = null;
    this.atmosphere = null;
    this.zoneKeys = new Set();
    this.occupancy = new Map(); // zona -> NPCs dentro dela (só as zonas citadas em 'ocupacao' no manifesto)
    this.occupancyZones = [];
    this.env = { indoors: false, interiorKey: null, rain: 0, night: 0, hour: 12 };
    this.nextStep = 0;
    this.lastSlice = -1;
    this.npcSteps = new Map(); // agente -> instante do próximo passo
    this.lastHour = -1;
    this.emittersBuilt = false;
  }

  async load(url) {
    this.manifest = await fetch(url).then((r) => r.json());
    if (this.world) this.buildEmitters();
    const base = new URL("../audio/sfx/", new URL(url, location.href)).href;
    const jobs = [];
    for (const [id, spec] of Object.entries(this.manifest.sons)) {
      for (const name of variantNames(id, spec)) jobs.push({ id, name });
    }
    // Efeitos de interação primeiro (respondem a tecla), depois os fundos
    jobs.sort((a, b) => Number(a.id.startsWith("amb_")) - Number(b.id.startsWith("amb_")));
    let cursor = 0;
    const worker = async () => {
      while (cursor < jobs.length) {
        const { id, name } = jobs[cursor++];
        try {
          const res = await fetch(`${base}${name}.mp3`);
          if (!res.ok) continue;
          const buffer = await this.ctx.decodeAudioData(await res.arrayBuffer());
          this.addBuffer(id, buffer);
        } catch (err) {
          console.warn(`[Alvor] SFX ${name} indisponível:`, err);
        }
      }
    };
    await Promise.all(Array.from({ length: LOAD_CONCURRENCY }, worker));
    this.buildSpots();
  }

  addBuffer(id, buffer) {
    const first = !this.buffers.has(id);
    if (first) this.buffers.set(id, []);
    const list = this.buffers.get(id);
    list.push(buffer);
    if (this.manifest.sons[id].cortes === "auto") {
      const all = this.slices.get(id) || [];
      for (const [start, dur] of detectSlices(buffer)) all.push([list.length - 1, start, dur]);
      this.slices.set(id, all);
    }
    if (first) this.onLoaded(id);
  }

  has(id) {
    return this.buffers.has(id);
  }

  attach({ world, player, npcs, atmosphere }) {
    this.world = world;
    this.player = player;
    this.npcs = npcs;
    this.atmosphere = atmosphere;
    if (this.manifest) this.buildEmitters();
  }

  roomAt(x, z) {
    const zone = this.world.zoneAt(x, z);
    return zone.interiorOf || (zone.building ? zone.key : null);
  }

  // --- Disparo avulso -------------------------------------------------------------------------
  // Retorna false se o som não está carregado (quem chamou decide o fallback).
  play(id, { pos = null, gain = 1, rate = 1, space = null, muffled = false, when = 0, offset = 0, duration = 0, variant = -1 } = {}) {
    const list = this.buffers.get(id);
    if (!list) return false;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = variant >= 0 ? list[variant] : pick(list);
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain * (this.manifest.sons[id].ganho ?? 1) * (muffled ? WALL_GAIN : 1);
    let node = src;
    if (muffled) {
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = MUFFLE_HZ;
      node = node.connect(lp);
    }
    node.connect(g);
    this.audio.route(g, pos, space);
    const t = when || ctx.currentTime;
    if (duration > 0) src.start(t, offset, duration);
    else src.start(t, offset);
    return true;
  }

  playFx(kind, pos, gain, space) {
    const id = this.manifest && this.manifest.fx[kind];
    // Interações acontecem ao lado do jogador (porta no batente, sino ao alcance): sem regra de cômodo
    return id ? this.play(id, { pos, gain, space, rate: rand(0.96, 1.04) }) : false;
  }

  playCue(kind) {
    const id = this.manifest && this.manifest.cues[kind];
    return id ? this.play(id) : false;
  }

  // --- Leitos (loops de fundo) ----------------------------------------------------------------
  onLoaded(id) {
    for (const spec of this.manifest.leitos) {
      if (spec.som === id) this.beds.push(this.makeLoop(id, spec, null));
    }
    for (const em of this.emitters) if (em.id === id) em.ready = true;
  }

  makeLoop(id, spec, pos, panSpec = null) {
    const ctx = this.ctx;
    const buffer = this.buffers.get(id)[0];
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = OPEN_HZ;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain);
    this.audio.route(gain, pos, panSpec);
    src.start(ctx.currentTime, Math.random() * buffer.duration);
    return { id, spec, src, filter, gain, level: 0, cutoff: OPEN_HZ, base: this.manifest.sons[id].ganho ?? 1 };
  }

  bedLevel(spec, env) {
    let f;
    if (spec.interior) {
      f = env.interiorKey && spec.interior.includes(env.interiorKey) ? 1 : 0;
    } else {
      let outside = spec.fora ?? 1;
      if (spec.zonas) for (const z of spec.zonas) if (this.zoneKeys.has(z)) outside = 1;
      f = env.indoors ? (spec.dentro ?? outside * (spec.abafado ?? 0.15)) : outside;
    }
    if (f <= 0) return 0;
    if (spec.periodo === "dia") f *= 1 - env.night;
    else if (spec.periodo === "noite") f *= env.night;
    if (spec.chuva === "com") f *= env.rain;
    else if (spec.chuva === "sem") f *= Math.max(0, 1 - env.rain * 1.5);
    if (spec.chuvaReduz) f *= 1 - env.rain * spec.chuvaReduz;
    if (spec.ocupacao) f *= Math.min(1, this.occupants(spec.ocupacao.zonas) / spec.ocupacao.cheio);
    return f;
  }

  occupants(zones) {
    let n = 0;
    for (const z of zones) n += this.occupancy.get(z) || 0;
    return n;
  }

  // Conta NPCs dentro das zonas que algum som usa como condição (a cada tick de 100 ms; poucas zonas)
  updateOccupancy() {
    if (!this.npcs) return;
    if (!this.occupancyZones.length) {
      const keys = new Set();
      for (const list of [this.manifest.leitos, this.manifest.pontuais]) {
        for (const spec of list) if (spec.ocupacao) for (const z of spec.ocupacao.zonas) keys.add(z);
      }
      this.occupancyZones = this.world.zones.filter((z) => keys.has(z.key));
    }
    this.occupancy.clear();
    for (const z of this.occupancyZones) {
      let n = 0;
      for (const a of this.npcs.agents) if (containsXZ(z, a.position.x, a.position.z)) n++;
      this.occupancy.set(z.key, (this.occupancy.get(z.key) || 0) + n);
    }
  }

  // --- Emissores (loops com posição) ----------------------------------------------------------
  buildEmitters() {
    if (this.emittersBuilt || !this.world) return;
    const world = this.world;
    for (const spec of this.manifest.emissores) {
      const points = [];
      if (spec.fogo) {
        for (const a of Object.values(world.anchors)) if (a.fire === spec.fogo) points.push([a.p[0], a.p[1], a.p[2]]);
      }
      if (spec.modelo) {
        for (const inst of world.city.instances) {
          if (spec.modelo.includes(inst.m)) points.push([inst.p[0], spec.altura ?? inst.p[1] + 0.6, inst.p[2]]);
        }
      }
      for (const p of points) {
        this.emitters.push({ id: spec.som, spec, p, roomKey: this.roomAt(p[0], p[2]), node: null, ready: this.buffers.has(spec.som) });
      }
    }
    this.emittersBuilt = true;
  }

  updateEmitters(env, lx, lz, now) {
    for (const em of this.emitters) {
      if (!em.ready) continue;
      const dx = em.p[0] - lx;
      const dz = em.p[2] - lz;
      const d2 = dx * dx + dz * dz;
      const max = em.spec.max;
      if (!em.node) {
        if (d2 > max * max) continue;
        em.node = this.makeLoop(em.id, em.spec, { x: em.p[0], y: em.p[1], z: em.p[2] }, { ref: em.spec.ref, max, rolloff: em.spec.rolloff });
      } else if (d2 > max * max * 1.3) {
        em.node.src.stop();
        em.node.gain.disconnect();
        em.node = null;
        continue;
      }
      // Parede entre ouvinte e fonte: cômodos diferentes (ou um dentro e outro fora)
      const walled = em.roomKey !== env.interiorKey;
      this.glide(em.node, em.node.base * (walled ? 0.35 : 1), walled ? MUFFLE_HZ : OPEN_HZ, now, 0.4);
    }
  }

  // --- Pontuais -------------------------------------------------------------------------------
  buildSpots() {
    this.spots = this.manifest.pontuais.map((spec) => ({ spec, timer: rand(spec.intervalo[0] * 0.3, spec.intervalo[1]) }));
  }

  spotAllowed(spec, env) {
    if (spec.periodo === "dia" && env.night > 0.5) return false;
    if (spec.periodo === "noite" && env.night < 0.5) return false;
    if (spec.horas && !inHours(env.hour, spec.horas)) return false;
    if (spec.chuva === "sem" && env.rain > 0.25) return false;
    if (spec.chuvaMin !== undefined && env.rain < spec.chuvaMin) return false;
    if (spec.ocupacao && this.occupants(spec.ocupacao.zonas) < (spec.ocupacao.min || 1)) return false;
    if (env.indoors && !spec.dentro) return false;
    if (spec.zonas) {
      let hit = false;
      for (const z of spec.zonas) if (this.zoneKeys.has(z)) hit = true;
      if (!hit) return false;
    }
    return true;
  }

  findWorker(anim, lx, lz) {
    if (!this.npcs) return null;
    for (const agent of this.npcs.agents) {
      if (!agent.activity || agent.activity.anim !== anim || agent.speed > 0.1) continue;
      const p = agent.position;
      if ((p.x - lx) ** 2 + (p.z - lz) ** 2 < 45 * 45) return p;
    }
    return null;
  }

  nearestFire(kind, lx, lz) {
    let best = null;
    let bestD = 20 * 20;
    for (const a of Object.values(this.world.anchors)) {
      if (a.fire !== kind) continue;
      const d = (a.p[0] - lx) ** 2 + (a.p[2] - lz) ** 2;
      if (d < bestD) {
        bestD = d;
        best = a.p;
      }
    }
    return best;
  }

  fireSpot(spot, env, lx, lz, when = 0) {
    const spec = spot.spec;
    const id = pick(spec.sons);
    if (!this.buffers.has(id)) return;
    let x;
    let y;
    let z;
    let placed = true; // posição num lugar do mapa (vale a regra de cômodo) ou sorteada em volta do ouvinte
    if (spec.npcAnim) {
      const p = this.findWorker(spec.npcAnim, lx, lz);
      if (!p) return;
      x = p.x;
      y = 1.0;
      z = p.z;
    } else if (spec.fogo) {
      const p = this.nearestFire(spec.fogo, lx, lz);
      if (!p) return;
      [x, y, z] = p;
    } else if (spec.p) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * (spec.raio || 0);
      x = spec.p[0] + Math.cos(a) * r;
      y = spec.p[1];
      z = spec.p[2] + Math.sin(a) * r;
    } else {
      const a = Math.random() * Math.PI * 2;
      const r = rand(spec.distancia[0], spec.distancia[1]);
      x = lx + Math.cos(a) * r;
      y = rand(spec.altura[0], spec.altura[1]);
      z = lz + Math.sin(a) * r;
      placed = false;
    }
    const far = spec.alcance || (spec.distancia ? spec.distancia[1] * 1.5 : 30);
    if (placed && (x - lx) ** 2 + (z - lz) ** 2 > far * far) return;
    const ref = spec.ref ?? (spec.distancia ? spec.distancia[0] : 3);
    const rolloff = spec.queda ?? 1.2;
    this.play(id, {
      pos: { x, y, z },
      space: { ref, max: far, rolloff },
      rate: spec.horasCheias ? 1 : rand(0.94, 1.06),
      gain: spec.horasCheias ? 1 : rand(0.8, 1),
      muffled: placed ? this.roomAt(x, z) !== env.interiorKey : env.indoors,
      when,
    });
  }

  // Sino das horas cheias: toca "toques" vezes quando o relógio do jogo cruza uma das horas listadas
  updateHourly(env, lx, lz, now) {
    const hour = Math.floor(env.hour);
    if (hour === this.lastHour) return;
    const first = this.lastHour < 0;
    this.lastHour = hour;
    if (first) return;
    for (const spot of this.spots) {
      const spec = spot.spec;
      if (!spec.horasCheias || !spec.horasCheias.includes(hour)) continue;
      for (let i = 0; i < (spec.toques || 1); i++) this.fireSpot(spot, env, lx, lz, now + 0.05 + i * BELL_GAP);
    }
  }

  // --- Passos ---------------------------------------------------------------------------------
  surface(room, x, z) {
    if (room) return "madeira";
    for (const r of this.world.city.ground.cobble) if (containsXZ(r, x, z)) return "pedra";
    return "terra";
  }

  stepAt(id, when, pos, gain, space) {
    const slices = this.slices.get(id);
    if (!slices || slices.length === 0) return false;
    let k = Math.floor(Math.random() * slices.length);
    if (k === this.lastSlice && slices.length > 1) k = (k + 1) % slices.length;
    this.lastSlice = k;
    const [variant, offset, duration] = slices[k];
    return this.play(id, { when, offset, duration, variant, pos, space, rate: rand(0.93, 1.07), gain: gain * rand(0.8, 1) });
  }

  updateSteps(env, now) {
    const p = this.player;
    if (!p || !p.moving || p.seat) {
      this.nextStep = 0;
      return;
    }
    const cfg = this.manifest.passos;
    const id = cfg[this.surface(env.interiorKey, p.position.x, p.position.z)];
    if (!this.slices.has(id)) return;
    const interval = p.running ? cfg.intervaloCorrer : cfg.intervaloAndar;
    if (this.nextStep < now) this.nextStep = now + 0.03;
    while (this.nextStep < now + 0.15) {
      this.stepAt(id, this.nextStep, null, p.running ? 1.25 : 1, null);
      this.nextStep += interval * rand(0.95, 1.05);
    }
  }

  // Passos dos NPCs que andam perto do ouvinte (no máximo cfg.max ao mesmo tempo), no ritmo da velocidade
  updateNpcSteps(env, lx, lz, now) {
    const cfg = this.manifest.passos.npc;
    if (!cfg || !this.npcs) return;
    const r2 = cfg.raio * cfg.raio;
    let active = 0;
    for (const agent of this.npcs.agents) {
      const p = agent.position;
      const walking = agent.speed > 0.3 && !agent.sitting;
      if (!walking || active >= cfg.max || (p.x - lx) ** 2 + (p.z - lz) ** 2 > r2) {
        this.npcSteps.delete(agent);
        continue;
      }
      active++;
      let next = this.npcSteps.get(agent) || 0;
      if (next < now) next = now + rand(0.02, 0.3);
      const interval = Math.min(0.7, Math.max(0.3, 0.68 / agent.speed));
      const room = this.roomAt(p.x, p.z);
      if (room !== env.interiorKey) {
        // Do outro lado da parede, passos não se ouvem (antes tocavam abafados e somavam ao barulho de fundo)
        this.npcSteps.delete(agent);
        continue;
      }
      const id = this.manifest.passos[this.surface(room, p.x, p.z)];
      const muffled = false;
      while (next < now + 0.15) {
        const slices = this.slices.get(id);
        if (!slices || slices.length === 0) break;
        const [variant, offset, duration] = pick(slices);
        this.play(id, {
          when: next,
          offset,
          duration,
          variant,
          pos: { x: p.x, y: 0.1, z: p.z },
          space: { ref: 1.5, max: cfg.raio, rolloff: 1.5 },
          rate: rand(0.95, 1.1) * (agent.scale < 0.65 ? 1.15 : 1),
          gain: cfg.ganho * rand(0.75, 1),
          muffled,
        });
        next += interval * rand(0.95, 1.05);
      }
      this.npcSteps.set(agent, next);
    }
  }

  // --- Tick (100 ms) --------------------------------------------------------------------------
  update(dt, zone, underRoof, rain) {
    if (!this.manifest || !this.world) return;
    const now = this.ctx.currentTime;
    const pos = this.player.position;
    const lx = pos.x;
    const lz = pos.z;
    this.zoneKeys.clear();
    for (const z of this.world.zones) if (containsXZ(z, lx, lz)) this.zoneKeys.add(z.key);
    const env = this.env;
    env.indoors = Boolean(zone.building || underRoof);
    env.interiorKey = zone.interiorOf || (zone.building ? zone.key : null);
    env.rain = rain;
    env.night = this.atmosphere ? this.atmosphere.state.night : 0;
    env.hour = this.atmosphere ? this.atmosphere.time.hour : 12;

    if (!this.occupancy.size) this.updateOccupancy();
    for (const bed of this.beds) {
      const level = Math.round(this.bedLevel(bed.spec, env) * bed.base * 50) / 50;
      const muffle = env.indoors && !bed.spec.interior && bed.spec.dentro === undefined;
      this.glide(bed, level, muffle ? MUFFLE_HZ : OPEN_HZ, now, 1.2);
    }
    this.updateOccupancy();
    this.updateEmitters(env, lx, lz, now);
    for (const spot of this.spots) {
      if (spot.spec.horasCheias) continue;
      spot.timer -= dt;
      if (spot.timer > 0) continue;
      spot.timer = rand(spot.spec.intervalo[0], spot.spec.intervalo[1]);
      if (this.spotAllowed(spot.spec, env)) this.fireSpot(spot, env, lx, lz);
    }
    if (this.spots.length) this.updateHourly(env, lx, lz, now);
    this.updateSteps(env, now);
    this.updateNpcSteps(env, lx, lz, now);
  }

  // Reagenda só quando o alvo muda (a timeline do AudioParam nunca cresce)
  glide(node, level, cutoff, now, tc) {
    if (node.level !== level) {
      node.level = level;
      node.gain.gain.cancelScheduledValues(now);
      node.gain.gain.setValueAtTime(node.gain.gain.value, now);
      node.gain.gain.setTargetAtTime(level, now, tc);
    }
    if (node.cutoff !== cutoff) {
      node.cutoff = cutoff;
      node.filter.frequency.cancelScheduledValues(now);
      node.filter.frequency.setValueAtTime(node.filter.frequency.value, now);
      node.filter.frequency.setTargetAtTime(cutoff, now, 0.3);
    }
  }

  // Estado legível para testes (alvorDebug.sfx())
  snapshot() {
    return {
      loaded: [...this.buffers.keys()],
      variants: Object.fromEntries([...this.buffers].map(([k, v]) => [k, v.length])),
      beds: this.beds.map((b) => ({ id: b.id, level: b.level, cutoff: b.cutoff })),
      emitters: this.emitters.filter((e) => e.node).map((e) => ({ id: e.id, p: e.p, level: e.node.level, cutoff: e.node.cutoff })),
      steps: Object.fromEntries([...this.slices].map(([k, v]) => [k, v.length])),
      npcSteps: this.npcSteps.size,
      zones: [...this.zoneKeys],
      occupancy: Object.fromEntries(this.occupancy),
    };
  }
}
