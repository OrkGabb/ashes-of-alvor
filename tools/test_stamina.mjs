// Histerese do vigor (bug do "quica" segurando Shift) + API de vida/mana do PlayerStats.
//
// Simula o jogo de verdade: 20 s a 60 fps segurando Shift e andando; a cada quadro o player pergunta
// canRun(wantsRun) e o resultado (running) volta para stats.update, como no app.js. Mede o que o jogador
// vê: quantas vezes alterna correr<->andar e quanto dura cada trecho.
//
// Critério (o mesmo para as duas implementações):
//   - transições <= 2 por episódio de esgotamento (vigor cai a <= 1 vindo de > 5);
//   - nenhum trecho completo de corrida ou caminhada mais curto que 0,5 s.
// CONTROLE NEGATIVO: a lógica antiga (copiada abaixo) roda a mesma simulação e PRECISA reprovar.
//
// Uso: node tools/test_stamina.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { PlayerStats, GameState, STAMINA } = await import(pathToFileURL(join(ROOT, "public", "js", "gamestate.js")).href);
const { CONFIG } = await import(pathToFileURL(join(ROOT, "public", "js", "config.js")).href);

const items = JSON.parse(readFileSync(join(ROOT, "public", "data", "items.json"), "utf-8"));
const quests = JSON.parse(readFileSync(join(ROOT, "public", "data", "quests.json"), "utf-8"));
const npcs = JSON.parse(readFileSync(join(ROOT, "public", "data", "npcs.json"), "utf-8"));

const FAILS = [];
const check = (cond, msg) => {
  console.log(`  [${cond ? "OK" : "FALHOU"}] ${msg}`);
  if (!cond) FAILS.push(msg);
};

const sent = [];
globalThis.fetch = async (_url, opts) => {
  sent.push(JSON.parse(opts.body));
  return { json: async () => ({}) };
};

const DT = 1 / 60;
const BASE_CTX = { running: false, moving: true, seated: false, rain: 0, night: 0, sheltered: true, nearFire: false, wantsRun: true, inCombat: false, manaRegenBonus: 0 };

function newStats() {
  return new PlayerStats(new GameState({ items, quests, npcs }));
}

// Lógica ANTIGA (como estava em gamestate.js antes do conserto), com a mesma física de CONFIG.stats
class OldStamina {
  constructor() {
    this.vigor = 80;
    this.maxVigor = 100;
    this.folego = 0;
    this.exhausted = false;
  }
  canRun() {
    return this.folego > 0 || (!this.exhausted && this.vigor > 1);
  }
  update(dt, ctx) {
    const s = CONFIG.stats;
    this.folego = Math.max(0, this.folego - dt);
    if (ctx.running && this.folego <= 0) {
      this.vigor = Math.max(0, this.vigor - s.sprintDrain * dt);
      if (this.vigor <= 0.5) this.exhausted = true;
    } else {
      const rest = ctx.seated ? CONFIG.props.seat.vigorRegenFactor : ctx.moving ? 0.5 : 1;
      this.vigor = Math.min(this.maxVigor, this.vigor + s.vigorRegen * dt * rest);
      if (this.exhausted && this.vigor > 25) this.exhausted = false;
    }
  }
}

/** Player do jogo: canRun uma vez por quadro, running só andando, running volta para update. */
function frame(stats, wantsRun, moving) {
  const can = stats.canRun(wantsRun);
  const running = wantsRun && moving && can;
  BASE_CTX.running = running;
  BASE_CTX.moving = moving;
  BASE_CTX.wantsRun = wantsRun;
  stats.update(DT, BASE_CTX);
  return running;
}

function simulateHoldShift(stats, seconds) {
  const frames = Math.round(seconds / DT);
  let prev = null;
  let transitions = 0;
  let segStart = 0;
  const segments = [];
  let episodes = 0;
  let armed = stats.vigor > 5;
  for (let i = 0; i < frames; i++) {
    const running = frame(stats, true, true);
    if (prev !== null && running !== prev) {
      transitions++;
      segments.push((i - segStart) * DT);
      segStart = i;
    }
    prev = running;
    if (armed && stats.vigor <= 1) {
      episodes++;
      armed = false;
    } else if (!armed && stats.vigor > 5) {
      armed = true;
    }
  }
  const shortest = segments.length ? Math.min(...segments.slice(1)) : Infinity; // o 1º trecho começa em t=0
  return { transitions, episodes, shortest, segments };
}

function passes(r) {
  return r.episodes > 0 && r.transitions <= 2 * r.episodes && r.shortest >= 0.5;
}

console.log("=== 1. Segurar Shift andando por 20 s (60 fps) ===");
const novo = simulateHoldShift(newStats(), 20);
console.log(`  novo: ${novo.transitions} transições, ${novo.episodes} esgotamentos, trecho mais curto ${novo.shortest.toFixed(2)} s`);
check(passes(novo), "lógica nova: no máximo 2 transições por esgotamento e nenhum trecho < 0,5 s");
const antigo = simulateHoldShift(new OldStamina(), 20);
console.log(`  antigo: ${antigo.transitions} transições, ${antigo.episodes} esgotamentos, trecho mais curto ${antigo.shortest.toFixed(3)} s`);
check(!passes(antigo), "CONTROLE NEGATIVO: a lógica antiga reprova o mesmo critério (quica quadro a quadro)");

console.log("=== 2. Regras da histerese ===");
{
  const st = newStats();
  st.vigor = 0.2;
  let r = true;
  for (let i = 0; i < 3 && r; i++) r = frame(st, true, true);
  check(st.exhausted && !r, "vigor zerado correndo: exausto e andando");
  const pausaAte = st.vigor;
  for (let i = 0; i < Math.floor((STAMINA.exhaustPause - 0.05) / DT); i++) frame(st, true, true);
  check(st.vigor === pausaAte, `regeneração pausada ~${STAMINA.exhaustPause} s após exaustão`);
  while (st.vigor < 15) frame(st, true, true);
  check(!frame(st, true, true), "segurando Shift com 15% de vigor: continua andando (sem quicar)");
  frame(st, false, true);
  frame(st, false, true);
  check(frame(st, true, true), "soltou e apertou de novo com >= 10%: volta a correr");
  // esgota de novo e tenta reapertar abaixo de 10%
  while (frame(st, true, true));
  while (st.vigor < 5) frame(st, true, true);
  frame(st, false, true);
  check(!frame(st, true, true), "reapertar com < 10% não destrava");
  while (st.vigor < 25) frame(st, true, true);
  check(frame(st, true, true), "com >= 25% destrava mesmo segurando o Shift");
  const parado = newStats();
  parado.vigor = 0;
  parado.exhausted = true;
  frame(parado, false, false);
  parado.vigor = 12;
  check(frame(parado, true, true), "parado (canRun chamado sem andar) também registra o soltar/apertar");
}

console.log("=== 3. Vida e mana ===");
{
  const st = newStats();
  check(st.vida === 100 && st.mana === 60 && st.maxVida === 100 && st.maxMana === 60, "vida 100 e mana 60 de items.json");
  check(st.damage(30) === 30 && st.vida === 70, "damage tira e devolve o dano aplicado");
  check(st.damage(500) === 70 && st.vida === 0 && st.dead, "damage não passa de zero; dead liga");
  st.update(1, { ...BASE_CTX, running: false, inCombat: false });
  check(st.vida === 0, "morto não regenera vida");
  check(st.heal(40) === 40 && !st.dead, "heal devolve vida");
  check(st.spendMana(100) === false && st.mana === 60, "spendMana sem mana suficiente: false e nada gasto");
  check(st.spendMana(25) === true && st.mana === 35, "spendMana gasta quando dá");
  st.update(1, { ...BASE_CTX, running: false, inCombat: true, manaRegenBonus: 1.5 });
  check(Math.abs(st.mana - 38.5) < 1e-6 && st.vida === 40, "em combate: mana regenera 2/s + bônus da arma, vida não");
  st.update(1, { ...BASE_CTX, running: false, inCombat: false });
  check(Math.abs(st.vida - 40.6) < 1e-6, "fora de combate: vida regenera 0,6/s");
  st.apply({ vida: 45, mana: 40 });
  check(Math.abs(st.vida - 85.6) < 1e-6 && st.mana === 60, "apply entende vida e mana (poções), com teto");
  st.vigor = 3;
  check(st.spendVigor(5) === false && st.vigor === 3 && st.spendVigor(2) === true && st.vigor === 1, "spendVigor (esquiva) só gasta se houver");
  st.load({ vigor: 40, calor: 50, vida: 22, mana: 11 });
  check(st.vida === 22 && st.mana === 11 && st.vigor === 40, "load lê vida e mana do servidor");
  st.sync();
  const last = sent[sent.length - 1];
  check(last && last.status.vida === 22 && last.status.mana === 11 && last.status.vigor === 40, "sync envia vida e mana junto com vigor/calor");
}

if (FAILS.length) {
  console.log(`\nFALHOU (${FAILS.length})`);
  process.exit(1);
}
console.log("\nOK: histerese do vigor sem quique (lógica antiga reprova o mesmo critério) e API de vida/mana");
