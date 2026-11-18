import * as THREE from "three";
import { ANIM, CONFIG, QUALITY, fetchJson, switchQuality } from "./js/config.js";
import { MaterialLibrary } from "./js/materials.js";
import { loadWorld, setCollectGlow, updateDetailCulling, updateWorldFx } from "./js/world.js";
import { Atmosphere } from "./js/atmosphere.js";
import { AmbientAudio } from "./js/audio.js";
import { Player } from "./js/player.js";
import { CharacterFactory } from "./js/characters.js";
import { NpcSystem } from "./js/npc.js";
import { GameState, PlayerStats } from "./js/gamestate.js";
import { InteractableRegistry, InteractionSystem, boardInteractable, collectibleInteractable, npcInteractable } from "./js/interaction.js";
import { PropSystem } from "./js/props.js";
import { Hud } from "./js/ui/hud.js";
import { Dialogue } from "./js/ui/dialogue.js";
import { BagWindow, BoardWindow, JournalWindow, NpcMenu, ShopWindow, SignWindow, WindowManager } from "./js/ui/windows.js";
import { CityMap } from "./js/ui/map.js";
import { PerfMonitor } from "./js/perf.js";
import { CombatSystem } from "./js/combat.js";
import { EnemySystem } from "./js/enemies.js";
import { FaunaSystem } from "./js/fauna.js";

// Bootstrap de Cinzas de Alvor: monta os sistemas e roda o loop (nenhuma closure criada por frame).

const container = document.getElementById("canvas-container");
const loadingOverlay = document.getElementById("loading-overlay");
const loaderBar = document.getElementById("loader-bar");
const loaderStatus = document.getElementById("loader-status");

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, QUALITY.maxPixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = CONFIG.render.exposure;
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, window.innerWidth / window.innerHeight, CONFIG.camera.near, CONFIG.camera.far);
const materials = new MaterialLibrary(renderer);
const atmosphere = new Atmosphere(scene, renderer, materials);
const audio = new AmbientAudio();
const player = new Player(scene, camera, renderer.domElement);
const factory = new CharacterFactory();
factory.setTextureTuner(materials);
const npcs = new NpcSystem(factory);
const interactions = new InteractionSystem();
const perf = new PerfMonitor(renderer, scene);
const clock = new THREE.Clock();

let world = null;
let data = null;
let game = null;
let stats = null;
let hud = null;
let dialogue = null;
let windows = null;
let npcMenu = null;
let bag = null;
let journal = null;
let board = null;
let mapView = null;
let mapWindowOpen = false;
let mapTimer = 0;
let marcoTimer = 0;
let freeCam = null;
let combat = null;
let enemies = null;
let fauna = null;
let defeatPending = false;
const statCtx = { running: false, moving: false, seated: false, rain: 0, night: 0, sheltered: false, nearFire: false, wantsRun: false, inCombat: false, manaRegenBonus: 0 };
let props = null;
const dialogueTarget = { position: null, headY: 0 };
const profile = { npcs: 0, player: 0, systems: 0, render: 0, frame: 0 };
window.alvorProfile = profile;
let tMark = 0;
function mark(key) {
  const now = performance.now();
  profile[key] += (now - tMark - profile[key]) * 0.05;
  tMark = now;
}

function setProgress(fraction, text) {
  loaderBar.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
  if (text) loaderStatus.textContent = text;
}

function weatherLabel() {
  const r = atmosphere.weather.rain;
  return r > 0.7 ? "chuva forte" : r > 0.3 ? "chuva" : r > 0.08 ? "garoa" : atmosphere.state.night > 0.5 ? "noite limpa" : "tempo aberto";
}

// Cena atual para o narrador: onde, quando e quem está por perto (o servidor põe as personas)
function sceneForNarrator(present) {
  const zone = world.zoneAt(player.position.x, player.position.z);
  return {
    local: `${zone.name}${zone.sub ? ` (${zone.sub})` : ""}`,
    marco: world.marcoAt(player.position.x, player.position.z) || "",
    hora: atmosphere.clockLabel(),
    clima: weatherLabel(),
    presentes: present.map((a) => ({ id: a.id, atividade: a.statusLabel })),
  };
}

// Objetos do mundo refletem o estado de jogo (SSOT no servidor, espelhado em GameState)
function syncWorldProps() {
  for (const key of Object.keys(world.collectibles)) {
    const exists = game.collectibleState(key).exists;
    world.setDynVisible(`collect:${key}`, exists);
    setCollectGlow(world, key, exists);
  }
}

async function collect(key) {
  const st = game.collectibleState(key);
  if (!st.exists) return;
  if (!st.eligible) {
    const hints = {
      bolinho: "O gato te encara e se encolhe. Talvez alguém esteja procurando por ele...",
      lenha_patio: game.temLenha ? "Você já carrega um feixe de lenha." : "É a lenha do Bram. Melhor perguntar antes.",
      suprimentos_estrada: "Carga caída de uma caravana. O Capitão Aldric no Portão Sul deve saber a quem pertence.",
      fragmento_marco: "Um fragmento de pedra com runas pulsantes. A Luna saberia o que isso significa.",
    };
    const hint = hints[key]
      || (key.startsWith("erva")
        ? "Folhas mornas como brasa. A alquimista da Botica deve saber para que servem."
        : key.startsWith("cogumelo")
          ? "Cogumelos luminosos da Mata Cinzenta. Talvez a Sera na Botica se interesse por eles."
          : "Melhor deixar isso aí por enquanto.");
    hud.toast(hint, "warn");
    return;
  }
  player.gesture(ANIM.pegar);
  audio.cue("pickup");
  const res = await game.action("coletar", { alvo: key });
  if (res.ok) {
    const [item] = Object.keys(res.gained || {});
    hud.toast(res.message, "success", item || null);
  } else if (res.message) {
    hud.toast(res.message, "warn");
  }
}

function talkTo(agent) {
  if (agent.kind === "named") {
    npcMenu.show(agent);
    return;
  }
  agent.lookAt(player.position.x, player.position.z);
  agent.bark = { text: agent.falas[Math.floor(Math.random() * agent.falas.length)], t: 4.5 };
  agent.barkCooldown = 12;
}

function onFirstGesture() {
  audio.start();
  audio.resume();
}

function closeEverything() {
  if (dialogue.isOpen) dialogue.close();
  windows.closeAll();
  if (mapWindowOpen) toggleMap(false);
}

function toggleMap(force) {
  mapWindowOpen = force ?? !mapWindowOpen;
  const el = document.getElementById("map-window");
  if (mapWindowOpen) windows.closeAll();
  el.classList.toggle("open", mapWindowOpen);
  el.setAttribute("aria-hidden", String(!mapWindowOpen));
  if (mapWindowOpen) mapView.renderFull(player.position, player.yaw);
  player.inputBlocked = mapWindowOpen || windows.anyOpen || dialogue.isOpen;
  if (mapWindowOpen) player.releasePointer();
}

function onKeyDown(e) {
  onFirstGesture();
  if (document.activeElement === dialogue.el.input) {
    if (e.code === "Escape") dialogue.close();
    return;
  }
  if (e.code === "Escape") {
    e.preventDefault();
    closeEverything();
    return;
  }
  if (dialogue.isOpen) return;
  if (e.code === "KeyE" && windows.closeOnInteract()) {
    e.preventDefault();
  } else if (e.code === "KeyE" && !windows.anyOpen && !mapWindowOpen) {
    const focused = interactions.focused;
    if (focused) {
      e.preventDefault();
      focused.interact();
    }
  } else if (e.code === "KeyB") {
    if (mapWindowOpen) toggleMap(false);
    bag.toggle();
    audio.fx("bolsa");
  } else if (e.code === "KeyJ") {
    if (mapWindowOpen) toggleMap(false);
    journal.toggle();
    audio.fx("pagina");
  } else if (e.code === "KeyM") {
    toggleMap();
  } else if (e.code === "KeyV" && !windows.anyOpen && !player.seat) {
    player.toggleView();
  } else if (e.code === "F4") {
    // Trocar de preset muda materiais e contagem de luzes: recarrega (o jogo salva no servidor)
    e.preventDefault();
    const next = switchQuality();
    stats.sync();
    hud.toast(`Qualidade: ${next === "alta" ? "Alta" : "Desempenho"} — recarregando...`);
    setTimeout(() => location.reload(), 600);
  } else if (e.code === "F3" || e.code === "Backquote") {
    e.preventDefault();
    perf.toggleOverlay();
  }
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function nearFire(pos) {
  for (let i = 0; i < world.fires.length; i++) {
    const f = world.fires[i].position;
    if ((f.x - pos.x) ** 2 + (f.z - pos.z) ** 2 < CONFIG.stats.fireRadius ** 2) return true;
  }
  return false;
}

// Fora da muralha = fora do retângulo do terreno plano da cidade (city.terrain, o mesmo que bloqueia os inimigos)
function isExtramuros(x, z) {
  const t = world.city.terrain;
  return !t || x < t.minX || x > t.maxX || z < t.minZ || z > t.maxZ;
}

// Derrota: o servidor decide onde acordar (cidade/acampamento) e o que se perde (só cobre; nunca itens de missão)
async function onPlayerDefeat() {
  if (defeatPending) return;
  defeatPending = true;
  const pos = player.position;
  const zone = world.zoneAt(pos.x, pos.z);
  closeEverything();
  const res = await game.defeat(zone.key, isExtramuros(pos.x, pos.z));
  const spots = world.city.respawns || {};
  const spot = (res && spots[res.respawn]) || spots.cidade || world.spawn;
  player.spawn(spot);
  if (res && res.state && res.state.status) stats.load(res.state.status);
  else stats.load({ vida: stats.maxVida * 0.5, mana: stats.maxMana * 0.5, vigor: 50 });
  const spotZone = world.zoneAt(spot.x, spot.z);
  for (let i = 0; i < 20; i++) player.updateCamera(0.1, spotZone, null, null);
  if (res && res.message) hud.toast(res.message, res.ok ? "info" : "warn");
  setTimeout(() => {
    combat.revive();
    defeatPending = false;
  }, 900);
}

// Abate real (o boneco de treino nunca chega aqui): o servidor sorteia cobre/drops e avança os contratos de caça
function onEnemyKilled(enemy) {
  game
    .reportKill(enemy.type, enemy.id)
    .then((res) => {
      if (res && res.ok && res.message) hud.toast(res.message, "success", Object.keys(res.gained || {})[0] || null);
    })
    .catch((err) => console.warn("[Alvor] Abate não registrado:", err));
}

function frame() {
  const dt = Math.min(clock.getDelta(), 0.1);
  // Hitstop: só jogador, combate e inimigos desaceleram; câmera, mundo e relógio seguem no tempo real
  const gdt = combat.scaleDt(dt);
  const elapsed = clock.elapsedTime;
  const pos = player.position;
  const zone = world.zoneAt(pos.x, pos.z);
  const tStart = performance.now();
  tMark = tStart;

  npcs.update(dt, elapsed, pos, camera, atmosphere.time.hour);
  mark("npcs");
  player.update(gdt, world, zone, npcs.agents);
  if (dialogue.isOpen && dialogue.talkingTo && !player.seat) player.faceTowards(dialogue.talkingTo.root.position, dt);
  props.update(dt);

  const busy = dialogue.isOpen || windows.anyOpen || mapWindowOpen;
  combat.update(gdt, elapsed, zone, busy);
  const focused = busy ? null : interactions.update(pos);
  hud.setPrompt(focused ? focused.label() : null, focused ? focused.muted() : false);
  hud.setZone(zone);
  mapView.markSeen(zone);
  dialogue.update(dt);

  let target = null;
  if (dialogue.isOpen && dialogue.talkingTo) {
    dialogueTarget.position = dialogue.talkingTo.root.position;
    dialogueTarget.headY = dialogue.talkingTo.headY;
    target = dialogueTarget;
  }
  player.updateCamera(dt, zone, target, null);
  // Câmera livre de inspeção (alvorDebug.freeCam): só para prints e medidas, nunca ligada no jogo normal
  if (freeCam) {
    camera.position.set(freeCam[0], freeCam[1], freeCam[2]);
    camera.lookAt(freeCam[3], freeCam[4], freeCam[5]);
  }
  // Depois da câmera do quadro: as barras de vida projetam com a pose final
  enemies.update(gdt, elapsed, camera, window.innerWidth, window.innerHeight);
  fauna.update(dt, elapsed, pos, camera);
  mark("player");

  materials.update(elapsed);
  atmosphere.update(dt, elapsed, camera, pos, zone, renderer.getPixelRatio());
  const pixelScale = window.innerHeight * renderer.getPixelRatio() * 0.9;
  updateWorldFx(world, elapsed, pixelScale);
  updateDetailCulling(world, camera, dt);
  const sheltered = zone.building || world.underRoof(pos.x, pos.z);
  audio.update(dt, camera, zone, sheltered, atmosphere.weather.rain);

  statCtx.running = player.running;
  statCtx.moving = player.moving;
  statCtx.wantsRun = player.wantsRun;
  statCtx.inCombat = combat.inCombat;
  statCtx.manaRegenBonus = combat.manaRegenBonus;
  statCtx.seated = props.seated;
  statCtx.rain = atmosphere.weather.rain;
  statCtx.night = atmosphere.state.night;
  statCtx.sheltered = sheltered;
  statCtx.nearFire = nearFire(pos);
  stats.update(dt, statCtx);
  hud.renderStats(dt);
  hud.setClock(atmosphere.clockLabel(), atmosphere.time.day, atmosphere.weather.rain, atmosphere.state.night);

  marcoTimer += dt;
  if (marcoTimer > 0.5) {
    marcoTimer = 0;
    const marco = world.marcoAt(pos.x, pos.z);
    if (marco && !game.marcos.has(marco)) {
      const qmBefore = game.missoes.mapa_capital;
      const mapMarcos = qmBefore && qmBefore.estado === "ativa" ? qmBefore.objetivo?.marcos : null;
      const isMapMarco = Boolean(mapMarcos && mapMarcos.includes(marco));
      game.visit(marco).then((res) => {
        if (res && res.ok) {
          if (isMapMarco) {
            const count = mapMarcos.filter((m) => game.marcos.has(m)).length;
            hud.toast(`Lugar anotado para o mapa da Luna (${count}/${mapMarcos.length})`, "success");
          } else {
            hud.toast(`Novo lugar descoberto: ${marco}`, "success");
          }
        }
      });
    }
  }
  mapView.updateMini(dt, pos, player.yaw);
  if (mapWindowOpen) {
    mapTimer += dt;
    if (mapTimer > 0.5) {
      mapTimer = 0;
      mapView.renderFull(pos, player.yaw);
    }
  }
  npcs.updateLabels(dt, pos, camera, window.innerWidth, window.innerHeight, dialogue.isOpen ? dialogue.talkingTo : null);
  mark("systems");

  perf.beforeRender();
  renderer.render(scene, camera);
  mark("render");
  perf.afterRender(dt);
  profile.frame += (performance.now() - tStart - profile.frame) * 0.05;
}

async function boot() {
  try {
    const keyart = new Image();
    keyart.onload = () => loadingOverlay.classList.add("has-art");
    keyart.src = "./art/keyart.jpg";
    setProgress(0.03, "Lendo os registros da capital...");
    const [items, quests, npcData] = await Promise.all([fetchJson(CONFIG.assets.items), fetchJson(CONFIG.assets.quests), fetchJson(CONFIG.assets.npcs)]);
    data = { items, quests, npcs: npcData };
    game = new GameState(data);
    stats = new PlayerStats(game);
    player.stats = stats;
    hud = new Hud(game, stats);
    await materials.init();
    if (QUALITY.surfaceDetail > 0) await materials.initDetail(QUALITY.surfaceDetail).catch((err) => console.warn("[Alvor] Detalhe de superfície indisponível:", err));
    setProgress(0.06, "Erguendo casas, torres e muralha...");
    world = await loadWorld(scene, materials, (f) => setProgress(0.06 + f * 0.6, `Erguendo a cidade... ${Math.round(f * 100)}%`));
    atmosphere.attachWorld(world);
    setProgress(0.7, "Chamando os moradores...");
    await player.build(factory);
    player.spawn(world.spawn);
    // Hora e clima salvos entram antes das rotinas: cada morador já nasce onde estaria nessa hora
    const saved = await fetchJson("/api/state").catch(() => null);
    if (saved && saved.state) atmosphere.load(saved.state.mundo);
    await npcs.init(world, scene, npcData, atmosphere.time.hour);
    setProgress(0.82, "Despertando as feras além da muralha...");
    data.enemies = await fetchJson(CONFIG.assets.enemies);
    enemies = new EnemySystem({ scene, factory, world, defs: data.enemies, audio });
    await enemies.init();
    enemies.onKill = onEnemyKilled;
    fauna = new FaunaSystem({ scene, world, factory });
    await fauna.init();
    setProgress(0.88, "Sincronizando a história...");

    dialogue = new Dialogue({ hud, game, npcs, player, audio, data, getScene: sceneForNarrator });
    windows = new WindowManager(player);
    windows.dialogue = dialogue;
    const shop = windows.add(new ShopWindow(windows, { game, data, hud, audio }));
    npcMenu = windows.add(new NpcMenu(windows, { game, data, dialogue, shop, hud, audio }));
    bag = windows.add(new BagWindow(windows, { game, stats, hud, audio, player }));
    journal = windows.add(new JournalWindow(windows, { game, data }));
    board = windows.add(new BoardWindow(windows, { game, data }));
    mapView = new CityMap(world, game, npcs, data);
    combat = new CombatSystem({ scene, camera, player, stats, game, audio, hud, data });
    combat.onDeath = onPlayerDefeat;
    combat.setEnemies(enemies);
    // Anisotropia/mipmap do preset em tudo que já está na cena (glTF dos kits, paletas, inimigos, fauna)
    materials.tuneScene(scene);

    for (const agent of npcs.agents) interactions.register(npcInteractable(agent, talkTo));
    for (const [key, spec] of Object.entries(world.collectibles)) interactions.register(collectibleInteractable(key, spec, game, collect));
    const sign = windows.add(new SignWindow(windows));
    // Portas, janelas, assentos, fontes, sino, alavancas, baús, santuários, placas e vistas (props.js)
    props = new PropSystem({ world, player, npcs, stats, audio, hud, atmosphere, signWindow: sign, onCollect: collect, canCollect: (k) => game.collectibleState(k).exists, onVisit: (m) => game.visit(m) });
    world.props = props;
    props.registerFixed(interactions);
    const kinds = props.defineKinds(new InteractableRegistry()).define("board", (spec) => boardInteractable(spec, () => board.open()));
    kinds.build(world.interactables, interactions);
    const hearth = world.anchors.Hearth;
    if (hearth) audio.setFirePosition(hearth.position);
    audio.attach({ world, player, npcs, atmosphere });
    game.addEventListener("change", syncWorldProps);

    const initial = await dialogue.loadInitial();
    if (initial && initial.state) stats.load(initial.state.status);
    stats.worldClock = atmosphere;
    syncWorldProps();
    hud.renderGame();

    const spawnZone = world.zoneAt(player.position.x, player.position.z);
    for (let i = 0; i < 30; i++) player.updateCamera(0.1, spawnZone, null, null);

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onFirstGesture, { passive: true });
    window.addEventListener("resize", onResize);
    window.addEventListener("pagehide", () => stats.sync());
    document.getElementById("interaction-prompt").addEventListener("click", () => {
      if (interactions.focused) interactions.focused.interact();
    });
    for (const b of document.querySelectorAll("#map-window [data-close]")) b.addEventListener("click", () => toggleMap(false));

    // Ganchos de inspeção para testes automatizados no navegador
    window.alvorDebug = {
      world,
      game,
      stats,
      npcs,
      atmosphere,
      player,
      dialogue,
      renderer,
      scene,
      perf,
      materials,
      combat,
      enemies,
      fauna,
      teleport(x, z, yaw = player.yaw) {
        player.position.set(x, player.position.y, z);
        player.yaw = yaw;
      },
      setHour(h) {
        atmosphere.time.hour = h;
      },
      focused: () => (interactions.focused ? { id: interactions.focused.id, label: interactions.focused.label() } : null),
      interact: () => interactions.focused && interactions.focused.interact(),
      props: () => props,
      doors: () => props.doors.snapshot(),
      toggleDoor: (id) => props.doors.toggle(id),
      gates: () => props.gates.snapshot(),
      toggleGate: (key) => props.gates.toggle(key),
      sit: (key) => props.seats.sit(props.seats.byKey.get(key)),
      stand: () => props.seats.stand(),
      setWindow: (id, open) => props.windows.setOpen(id, open),
      // Registra um interativo extra (mesmo contrato de city.interactables) para testes
      addInteractable: (spec) => kinds.build([spec], interactions),
      audio,
      sfx: () => (audio.scape ? audio.scape.snapshot() : null),
      // [x, y, z, alvoX, alvoY, alvoZ] fixa a câmera; null devolve a câmera do jogador
      freeCam(pose) {
        freeCam = pose;
      },
      lights: () => atmosphere.pointLights.map((s) => ({ key: s.anchor ? s.anchor.key : null, intensity: +s.light.intensity.toFixed(2) })),
      camera,
      // Custo real por frame (CPU+GPU, sincronizado com readPixels) com sombra recalculada ou não
      bench(frames = 20, shadows = true) {
        const gl = renderer.getContext();
        const px = new Uint8Array(4);
        renderer.render(scene, camera);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        const t0 = performance.now();
        for (let i = 0; i < frames; i++) {
          renderer.shadowMap.needsUpdate = shadows;
          renderer.render(scene, camera);
        }
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return +((performance.now() - t0) / frames).toFixed(2);
      },
    };

    // Roda ~1 s de jogo atrás da tela de carregamento (texturas, shaders e esqueletos já na GPU)
    // e só então calibra: medir no primeiro quadro superestimava o custo em ~65%.
    setProgress(0.96, "Calibrando desempenho da GPU...");
    renderer.setAnimationLoop(frame);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    renderer.setAnimationLoop(null);
    camera.updateMatrixWorld();
    const calib = perf.calibrate(scene, camera, atmosphere);
    console.info(`[Alvor] GPU ${calib.gpuTier}: ${calib.calibratedMs} ms/frame nativo -> DPR ${calib.dpr}, PointLights ${atmosphere.pointLights.length}, sombra 1/${calib.shadowEvery}, ${world.stats.drawBuckets} blocos estáticos`);
    clock.getDelta();
    setProgress(1, "Cinzas de Alvor desperta!");
    renderer.setAnimationLoop(frame);
    setTimeout(() => loadingOverlay.classList.add("hidden"), 300);
  } catch (err) {
    console.error("[Alvor] Falha ao iniciar:", err);
    loaderStatus.textContent = `Falha ao carregar o mundo: ${err.message}`;
  }
}

boot();
