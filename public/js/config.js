// Parâmetros ajustáveis do cliente (fonte única). Layout, colisores, zonas, luzes e navegação NÃO
// ficam aqui: vêm de assets/city/city.json (gerado por tools/build_city.py). Conteúdo (NPCs, itens,
// missões) vem de data/*.json, compartilhado com o servidor.
export const CONFIG = Object.freeze({
  assets: Object.freeze({
    city: "./assets/city/city.json",
    npcs: "./data/npcs.json",
    items: "./data/items.json",
    quests: "./data/quests.json",
    characters: "./assets/kits/chars/",
    textureManifest: "./textures/manifest.json",
    textureDir: "./textures/",
    detailSpec: "./textures/detail.json",
    audioWorklet: "./js/ambience-worklet.js",
    sfx: "./data/sfx.json",
    enemies: "./data/enemies.json",
    portraitDir: "./art/portraits/",
    iconDir: "./art/icons/",
  }),
  render: Object.freeze({
    // Piso da resolução adaptativa. Abaixo de ~0,85 o serrilhado e o borrão do upscale dominam a imagem
    // (antes: 0,6). O piso efetivo também nunca fica abaixo de minFractionOfCap x teto do preset
    // (teto = min(DPR nativo, QUALITY.maxPixelRatio)) — ver PerfMonitor.floorDpr().
    minPixelRatio: 0.85,
    minFractionOfCap: 0.8,
    // Escala adaptativa em passos pequenos e com histerese: só desce após dprDownAfter janelas seguidas
    // acima do orçamento e só sobe após dprUpAfter janelas seguidas abaixo (cada janela ~1,5 s)
    dprStepDown: 0.05,
    dprStepUp: 0.05,
    dprDownAfter: 2,
    dprUpAfter: 3,
    exposure: 1.05,
    shadowMapSize: 2048,
    shadowRange: 34,
    chunkSize: 24,
  }),
  lights: Object.freeze({
    reassignEvery: 0.2,
    doorwayReach: 5.0,
  }),
  // Relógio: o estado vem do save (servidor); estes valores só valem para um jogo novo. O dia anda a
  // 1 min de jogo por segundo e a noite corre mais rápido (antes: 11,5 min reais de escuro seguidos).
  time: Object.freeze({
    startHour: 9.0,
    minutesPerSecond: 1.0,
    nightMinutesPerSecond: 2.4,
  }),
  // Clima: sorteio ponderado de intensidade de chuva a cada 'hold' segundos (0 = céu aberto)
  weather: Object.freeze({
    startRain: 0.0,
    minHold: 120,
    maxHold: 300,
    rate: 0.08,
    table: Object.freeze([
      Object.freeze({ weight: 0.5, rain: 0.0 }),
      Object.freeze({ weight: 0.2, rain: 0.3 }),
      Object.freeze({ weight: 0.18, rain: 0.7 }),
      Object.freeze({ weight: 0.12, rain: 1.0 }),
    ]),
  }),
  player: Object.freeze({
    model: "Rogue_Hooded",
    scale: 0.8,
    recolor: Object.freeze({ "1,1": "#5f6672", "0,1": "#2c3a55", "3,2": "#3d5f8f", "1,0": "#3a2c25" }),
    hide: Object.freeze(["Knife", "Knife_Offhand", "1H_Crossbow", "2H_Crossbow", "Throwable"]),
    radius: 0.32,
    walkSpeed: 3.6,
    runSpeed: 6.4,
    coldSpeedFactor: 0.75,
    eyeHeight: 1.5,
    mouseSensitivity: 0.0024,
    // Velocidade suavizada (aproximação exponencial, 1/s): sem degrau ao trocar andar/correr/parar
    accel: 7.5,
    decel: 11,
    // Troca de animação andar <-> correr por velocidade com histerese (fração entre walkSpeed e runSpeed)
    runAnimEnter: 0.6,
    runAnimExit: 0.3,
    // Abaixo disso (m/s) e sem tecla de movimento, a animação volta para parado
    idleSpeed: 0.35,
    // Campo de visão extra ao correr (graus) e taxa da interpolação (1/s)
    runFovBoost: 6,
    fovRate: 4.5,
    // Empurrão recebido (golpe de inimigo, recuo): decaimento exponencial (1/s)
    knockDecay: 7,
  }),
  // Combate (combat.js): fonte única de custos, recargas, alcances e tempos. Atributos da arma (dano,
  // alcance, arco, recarga, poder mágico, regen de mana) vêm de data/items.json (campo "combate").
  combat: Object.freeze({
    inputBuffer: 0.25,          // s que um clique/tecla fica guardado enquanto outra ação termina
    combatMemory: 6,            // s em combate após golpear ou ser golpeado
    unarmed: Object.freeze({ dano_corpo: 5, alcance: 1.5, arco_graus: 80, recarga: 0.6, poder_magico: 1.0, regen_mana: 0 }),
    // Visual/sonoro por arma (id do item); arma sem entrada usa "sword"
    styles: Object.freeze({
      espada_curta: "sword",
      cajado_aprendiz: "staff",
    }),
    melee: Object.freeze({
      impactAt: 0.17,           // s após o início do golpe em que o dano é resolvido
      swingTime: 0.3,           // s de duração do rastro
      moveFactor: 0.35,         // fração da velocidade enquanto golpeia
      lockFraction: 0.55,       // fração da recarga em que a animação de locomoção não sobrescreve o golpe
      knock: 4.2,               // impulso de empurrão (m/s) no inimigo
      comboWindow: 0.9,         // s para o próximo clique continuar a sequência
      comboBonus: 1.25,         // multiplicador do 3º golpe
      variance: 0.1,            // +-10% de dano
      assistRange: 1.6,         // m além do alcance em que o golpe gira o corpo para o inimigo mais próximo
      assistArc: 70,            // graus em torno da mira considerados pela assistência
      trailInner: 0.45,
      trailHeight: 1.05,
    }),
    hitstop: Object.freeze({ time: 0.06, scale: 0.08 }),
    dodge: Object.freeze({
      cost: 18,                 // vigor
      speed: 11,
      time: 0.24,
      iframes: 0.35,
      cooldown: 0.55,
    }),
    hurt: Object.freeze({
      iframes: 0.45,            // invulnerável após levar um golpe (evita dano múltiplo do mesmo ataque)
      knock: 5.5,
      flashTime: 0.35,
      faintDelay: 1.8,          // s entre cair e o app.js tratar a derrota
      reviveGrace: 2.5,         // s de invulnerabilidade ao acordar
    }),
    numbers: Object.freeze({ life: 0.9, rise: 1.1, pool: 24 }),
    // Ordem = tecla (1, 2, 3). custo em mana, recarga em s; dano/cura multiplicados por poder_magico
    spells: Object.freeze([
      Object.freeze({ id: "arcano", nome: "Disparo Arcano", sigla: "DA", custo: 8, recarga: 0.45, dano: 16, velocidade: 24, alcance: 26, raio: 0.32, knock: 3.0, mira: 12 }),
      Object.freeze({ id: "pulso", nome: "Pulso Rúnico", sigla: "PR", custo: 18, recarga: 4.0, dano: 20, raioArea: 4.2, knock: 7.5, atraso: 0.12, duracao: 0.55 }),
      Object.freeze({ id: "luz", nome: "Luz Restauradora", sigla: "LR", custo: 20, recarga: 6.0, cura: 30, duracao: 1.2 }),
    ]),
    particles: 220,
    projectiles: 8,
  }),
  camera: Object.freeze({
    fov: 60,
    near: 0.1,
    far: 280,
    thirdDistance: 3.8,
    thirdHeight: 2.0,
    clampMargin: 0.3,
    dialogueFrameDrop: 0.28,
  }),
  stats: Object.freeze({
    sprintDrain: 16,
    vigorRegen: 7,
    rainColdPerSecond: 0.22,
    nightColdPerSecond: 0.05,
    roofWarmPerSecond: 1.6,
    fireWarmPerSecond: 6.0,
    fireRadius: 6.0,
    coldThreshold: 25,
    syncEvery: 15,
  }),
  interact: Object.freeze({
    npcRadius: 3.4,
    deliveryRadius: 4.6,
  }),
  npc: Object.freeze({
    animDistance: 55,
    labelDistance: 9,
    barkDistance: 5,
    barkCooldown: 22,
  }),
  rain: Object.freeze({
    drops: 3200,
    height: 18,
    speed: 15,
    streak: 0.42,
    wind: [-0.9, 0.35],
    radius: 34,
  }),
  ui: Object.freeze({
    typewriterCharsPerSecond: 90,
    toastMs: 4200,
    autoScrollSlack: 48,
  }),
  // Interiores falsos (interiors.js): sala em paralaxe atrás de cada janela/porta sem interior real
  interiors: Object.freeze({
    openTime: 0.4,             // s para as venezianas abrirem/fecharem por completo
    lampTime: 0.3,             // s para a lâmpada da sala acender/apagar
    windowInset: 0.18,         // m do quadro do city.json até o plano do vidro (dentro da parede)
    doorInset: 0.12,           // m da face externa até o plano do vão (atrás da folha fechada)
    doorDepth: 2.6,            // profundidade da sala de entrada atrás das portas trancadas
    cover: 0.22,               // m de sobra do quad além do vão (a própria parede esconde o excesso)
    roomWidth: 2.6,            // largura da sala virtual
    roomShift: 0.45,           // deslocamento lateral máximo da sala em relação à janela
    ceilingDrop: 0.22,         // forro abaixo do pé-direito do módulo (vigas)
    atlasTile: 160,            // px por sprite no atlas de móveis gerado no carregamento
    dayAmbient: 0.42,          // luz do dia que entra pela janela (fração da rua: sala parece escura)
    nightAmbient: 0.022,       // sala apagada à noite: escura, mas não preta
    lampGain: 1.5,             // brilho da lâmpada da sala (as "janelas acesas" da cidade)
    glass: 0.75,               // força do reflexo de Fresnel no vidro
    patternFade: Object.freeze([9, 30]),   // m: papel de parede/piso perdem contraste entre essas distâncias
    realGlow: 0.85,            // brilho aditivo das janelas de prédios com interior modelado
  }),
  // Interatividade do mundo (props.js): portas, janelas, assentos, fontes, sino, alavanca, placas
  props: Object.freeze({
    hinge: Object.freeze({
      doorNode: "door",          // nó da folha nos módulos Kenney wall-door / wall-wood-door
      angle: -1.75,              // ~100° para dentro (+X local aponta para fora do prédio)
      dur: 0.5,                  // segundos para abrir por completo (com easing)
    }),
    door: Object.freeze({
      reach: 1.9,
      priority: 3,
      colliderOffAt: 0.55,       // fração da abertura a partir da qual o vão deixa passar
      npcRadius: 1.6,            // NPC a essa distância de uma porta fechada a abre sozinho
      autoCloseDelay: 4.0,       // ...e ela fecha depois que todos saíram (só se estava fechada)
      npcCheckEvery: 0.2,
      labelOpen: "Abrir a porta",
      labelClose: "Fechar a porta",
      labelKnock: "Bater à porta",
    }),
    knock: Object.freeze({
      cooldown: 6.0,
      delay: Object.freeze([0.8, 1.6]),         // tempo até alguém responder lá dentro
      crackFraction: 0.25,                      // ~25° de fresta (fração do giro total)
      crackHold: Object.freeze([2.2, 3.4]),
      openChanceDay: 0.55,                      // fresta + resposta
      answerChanceDay: 0.3,                     // só a voz, porta fechada
      openChanceNight: 0.2,
      answerChanceNight: 0.45,
      voicePrefix: "Uma voz lá dentro: ",
    }),
    // Respostas de moradores ao bater (sorteadas; "noite" vale com state.night > 0,5)
    batidas: Object.freeze({
      fresta: Object.freeze(["Já vai!", "Pois não?", "Ah, é você... o que deseja?", "Se for cobrança, volte amanhã.", "Hm? Achei que fosse o padeiro."]),
      frestaNoite: Object.freeze(["Quem é a essa hora?", "Só abro de dia, viu?", "Vá dormir, forasteiro.", "A guarda sabe que você anda batendo nas portas?"]),
      fechada: Object.freeze(["Não tem ninguém!", "Hoje não!", "Já demos esmola essa semana!", "Estou ocupado, volte depois."]),
      fechadaNoite: Object.freeze(["Vá embora, a gente já dormiu!", "Mais uma batida e eu chamo a guarda!", "Não abro de noite pra ninguém."]),
      silencio: Object.freeze(["Ninguém responde.", "Silêncio. Só a chuva no telhado.", "Você ouve passos lá dentro... e depois nada."]),
    }),
    window: Object.freeze({
      reach: 1.8,
      facingDot: 0.45,           // cos do ângulo entre o olhar e a normal para dentro da janela
      labelOpen: "Abrir a janela",
      labelClose: "Fechar a janela",
    }),
    seat: Object.freeze({
      reach: 1.6,
      priority: 2,
      npcNodeRadius: 0.65,       // nó de assento de NPC (seatY) que coincide com o assento (2 raios de corpo)
      standOffset: 0.55,         // levanta e dá esse passo à frente (sai do colisor do banco)
      vigorRegenFactor: 3.0,
      labelStand: "Levantar-se",
      labelBusy: "Ocupado",
    }),
    drink: Object.freeze({
      reach: 1.6,
      priority: 2,
      cooldown: 20,
      restore: Object.freeze({ vigor: 15, calor: 0 }),
      labelCooldown: "Você já bebeu — a água está gelada",
      toast: "Água fria da fonte. O fôlego volta.",
    }),
    bell: Object.freeze({
      reach: 2.2,
      priority: 2,
      cooldown: 8,
      npcRadius: 32,             // NPCs até essa distância se viram para o sino
      toast: "O sino ecoa sobre os telhados de Alvor.",
      labelCooldown: "O sino ainda vibra...",
    }),
    gate: Object.freeze({
      reach: 1.8,
      priority: 3,
      colliderOffAt: 0.8,        // fração da abertura a partir da qual o portão deixa passar
      labelOpen: "Abrir o portão",
      labelClose: "Fechar o portão",
    }),
    chest: Object.freeze({
      reach: 1.5,
      priority: 3,
      labelOpen: "Abrir o baú",
      labelClose: "Fechar o baú",
      emptyToast: "Vazio... só poeira e um botão de latão.",
    }),
    hearth: Object.freeze({
      reach: 2.2,
      priority: 2,
      cooldown: 12,
      calor: 14,
      labelCooldown: "As mãos ainda estão quentes",
      toast: "O calor do fogo sobe pelos dedos.",
    }),
    sign: Object.freeze({
      reach: 1.8,
      priority: 2,
    }),
  }),
});

// Animações KayKit (mesmo esqueleto nos 5 corpos) por intenção de rotina
export const ANIM = Object.freeze({
  idle: "Idle",
  walk: "Walking_A",
  run: "Running_A",
  sentar: "Sit_Chair_Idle",
  sentarDescer: "Sit_Chair_Down",
  sentarLevantar: "Sit_Chair_StandUp",
  trabalhar: "Interact",
  pegar: "PickUp",
  conjurar: "Spellcasting",
  forjar: "1H_Melee_Attack_Chop",
  vigiar: "Unarmed_Idle",
  comemorar: "Cheer",
  usar: "Use_Item",
  // Combate (nomes conferidos nos clipes do Rogue_Hooded.glb)
  golpeEspada: Object.freeze(["1H_Melee_Attack_Slice_Diagonal", "1H_Melee_Attack_Slice_Horizontal", "1H_Melee_Attack_Chop"]),
  golpeCajado: Object.freeze(["1H_Melee_Attack_Chop", "1H_Melee_Attack_Slice_Horizontal", "1H_Melee_Attack_Stab"]),
  golpeMao: Object.freeze(["Unarmed_Melee_Attack_Punch_A", "Unarmed_Melee_Attack_Punch_B", "Unarmed_Melee_Attack_Kick"]),
  magiaDisparo: "Spellcast_Shoot",
  magiaPulso: "Spellcasting",
  magiaCura: "Spellcast_Raise",
  esquivaFrente: "Dodge_Forward",
  esquivaTras: "Dodge_Backward",
  esquivaEsquerda: "Dodge_Left",
  esquivaDireita: "Dodge_Right",
  ferido: "Hit_A",
  morte: "Death_A",
});

// Presets de qualidade (F4 alterna e recarrega). "alta" mantém todo o visual e aceita ~40 fps numa
// GPU integrada; "desempenho" corta o que foi medido como caro para cravar 60 fps.
export const QUALITY_PRESETS = Object.freeze({
  alta: Object.freeze({
    label: "Alta",
    ibl: true,               // reflexo de ambiente em todos os materiais (~2,5 ms numa iGPU)
    groundDetail: true,      // normal/roughness map na grama e no calçamento (~1 ms)
    surfaceDetail: 60,       // detalhe pintado nas casas até essa distância em metros (0 = desligado)
    lightSlots: 6,           // PointLights reais simultâneas
    shadowEvery: 1,          // mapa de sombra todo quadro
    detailDistance: 70,      // móveis/adereços visíveis até essa distância
    gpuHighMs: 25,           // acima disso baixa a resolução (~40 fps)
    gpuLowMs: 18,            // abaixo disso sobe a resolução
    maxPixelRatio: 1.25,
    anisotropy: 8,           // filtro anisotrópico máximo das texturas (limitado pela GPU)
  }),
  desempenho: Object.freeze({
    label: "Desempenho",
    ibl: false,
    groundDetail: false,
    surfaceDetail: 0,
    lightSlots: 3,
    shadowEvery: 2,
    detailDistance: 40,
    gpuHighMs: 13,
    gpuLowMs: 9,
    maxPixelRatio: 1.75,
    anisotropy: 4,
  }),
});

function readQualityKey() {
  try {
    const k = localStorage.getItem("alvor_quality");
    if (k && QUALITY_PRESETS[k]) return k;
  } catch (_) {
    /* armazenamento indisponível: usa o padrão */
  }
  return "alta";
}

export const QUALITY_KEY = readQualityKey();
export const QUALITY = QUALITY_PRESETS[QUALITY_KEY];

export function switchQuality() {
  const next = QUALITY_KEY === "alta" ? "desempenho" : "alta";
  try {
    localStorage.setItem("alvor_quality", next);
  } catch (_) {
    /* sem armazenamento: a troca vale só nesta carga */
  }
  return next;
}

// Curva de cintilação compartilhada por luzes e materiais emissivos (sem alocação por frame)
export function flicker(t, seed, speed = 1.0) {
  return (
    Math.sin(t * 7.3 * speed + seed) * 0.5 +
    Math.sin(t * 13.1 * speed + seed * 1.7) * 0.3 +
    Math.sin(t * 23.7 * speed + seed * 2.3) * 0.2
  );
}

export function dampFactor(rate, dt) {
  return 1 - Math.exp(-rate * dt);
}

export function dampAngle(current, target, rate, dt) {
  let diff = target - current;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  return current + diff * dampFactor(rate, dt);
}

export async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}
