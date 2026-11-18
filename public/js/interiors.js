import * as THREE from "three";
import { CONFIG } from "./config.js";

// Interiores falsos por "interior mapping" (Joost van Dongen, 2008 — as janelas de Spider-Man):
// cada janela/porta de prédio sem interior modelado vira um quad dentro da parede, e o fragment
// shader lança o raio da câmera numa caixa virtual atrás do vidro (fundo, laterais, piso, forro).
// O ponto atingido é sombreado proceduralmente conforme o estilo do cômodo (papel de parede,
// tábuas, lambri, vigas) e a luz de uma lâmpada pontual; móveis são "cartões" paralelos à janela em
// profundidades diferentes, amostrados de um atlas desenhado uma única vez em canvas no carregamento.
//
// Custo: um draw call para todas as salas (geometria fundida, dados por vértice), um para o brilho
// aditivo das janelas de prédios com interior real. O quad fica DENTRO da espessura da parede e é
// desenhado depois dos opacos (renderOrder 1): a própria parede o recorta no formato exato do vão
// (inclusive o arco das janelas redondas) e o early-z descarta o excesso antes do shader rodar.
//
// Estado por janela (abertura das venezianas, lâmpada) mora num atributo dinâmico de 2 floats por
// vértice, reescrito só no trecho da janela que mudou (addUpdateRange) durante a animação.
// Portas trancadas leem o giro da folha (world.hinges, animado por props.js) e desenham a folha
// aberta dentro da sala virtual, já que a folha real gira para trás do plano do quad.

// --------------------------------------------------------------------------------------------
// Geometria medida nos GLBs Kenney (fatos do asset, em células; 1 célula = city.cell metros)
// --------------------------------------------------------------------------------------------
// Folha da porta Kenney: dobradiça a 0,05 célula para dentro da face externa (nó 'door' em x=0,45),
// no lado -Z local (u = -meia-largura do vão); arco pleno no topo (raio = meia-largura).
const DOOR_HINGE_IN = 0.05;

// Tipos de quad (atributo aGlass.w = tipo + 2 × espelhado)
const KIND_WINDOW = 0;
const KIND_DOOR = 1;

// Padrões procedurais do shader (índices estáveis: novos estilos só escolhem entre eles)
const PAPER = Object.freeze({ plaster: 0, stripes: 1, damask: 2, stone: 3, planks: 4, timber: 5 });
const FLOOR = Object.freeze({ planks: 0, flags: 1, checker: 2, dirt: 3 });

// --------------------------------------------------------------------------------------------
// Sprites do atlas: [largura m, altura m, altura de montagem m (0 = no piso), desenho]
// O desenho recebe um pincel em metros (origem no pé do sprite, y para cima) e um rng.
// --------------------------------------------------------------------------------------------
const WOOD_D = "#3f2717";
const WOOD_M = "#6a4327";
const WOOD_L = "#8f6038";
const IRON = "#34343a";
const LINEN = "#ddd2b8";
const GOLD = "#d9aa3a";
const STONE = "#77736e";
const STONE_D = "#57534f";
const BRICK = "#8a4a32";
const FLAME = "#ffd27a";
const EMBER = "#ff7a2a";

function bed(cloth) {
  return (b) => {
    b.rect(-1.0, 0, 0.09, 1.0, WOOD_D);
    b.rect(-1.0, 0.92, 0.09, 0.08, WOOD_M);
    b.rect(0.91, 0, 0.09, 0.66, WOOD_D);
    b.rect(-0.94, 0.16, 1.86, 0.16, WOOD_M);
    b.rect(-0.92, 0.32, 1.82, 0.16, LINEN);
    b.rect(-0.55, 0.26, 1.44, 0.26, cloth);
    b.rect(-0.55, 0.47, 1.44, 0.05, "#00000033");
    b.rect(-0.6, 0.26, 0.06, 0.26, LINEN);
    b.ellipse(-0.76, 0.54, 0.16, 0.08, "#efe8d8");
    b.rect(-0.92, 0, 0.06, 0.16, WOOD_D);
    b.rect(0.84, 0, 0.06, 0.16, WOOD_D);
  };
}

function banner(cloth, emblem) {
  return (b) => {
    b.rect(-0.42, 1.52, 0.84, 0.05, WOOD_D);
    b.circle(-0.43, 1.545, 0.04, GOLD);
    b.circle(0.43, 1.545, 0.04, GOLD);
    b.poly([[-0.34, 1.52], [0.34, 1.52], [0.34, 0.05], [0.0, 0.3], [-0.34, 0.05]], cloth);
    b.rect(-0.34, 1.38, 0.68, 0.05, GOLD);
    b.circle(0, 0.92, 0.17, emblem);
    b.circle(0, 0.92, 0.1, cloth);
    b.poly([[0, 1.04], [0.06, 0.92], [0, 0.8], [-0.06, 0.92]], emblem);
  };
}

function candle(b, x, y, h = 0.12) {
  b.rect(x - 0.022, y, 0.044, h, "#eee4c8");
  b.glowEllipse(x, y + h + 0.045, 0.024, 0.05, FLAME, "candle");
}

const SPRITE_DEFS = Object.freeze({
  table: [1.3, 0.98, 0, (b) => {
    b.rect(-0.6, 0, 0.07, 0.66, WOOD_D);
    b.rect(0.53, 0, 0.07, 0.66, WOOD_D);
    b.rect(-0.6, 0.58, 1.2, 0.1, WOOD_D);
    b.rect(-0.65, 0.68, 1.3, 0.06, WOOD_M);
    b.poly([[-0.38, 0.74], [-0.26, 0.74], [-0.24, 0.86], [-0.28, 0.94], [-0.36, 0.94], [-0.4, 0.86]], "#a8653a");
    b.ellipse(0.0, 0.77, 0.15, 0.035, "#c9c2b0");
    candle(b, 0.34, 0.74);
  }],
  chair: [0.5, 1.02, 0, (b) => {
    b.rect(-0.22, 0, 0.05, 1.02, WOOD_M);
    b.rect(0.17, 0, 0.05, 1.02, WOOD_M);
    b.rect(-0.24, 0.44, 0.48, 0.06, WOOD_L);
    b.rect(-0.2, 0.72, 0.4, 0.05, WOOD_M);
    b.rect(-0.2, 0.88, 0.4, 0.05, WOOD_M);
  }],
  bed: [2.0, 1.0, 0, bed("#8c2f2a")],
  bed_blue: [2.0, 1.0, 0, bed("#2f4a7a")],
  wardrobe: [1.0, 1.98, 0, (b) => {
    b.rect(-0.48, 0.06, 0.96, 1.8, WOOD_M);
    b.rect(-0.5, 1.86, 1.0, 0.12, WOOD_D);
    b.rect(-0.44, 0.12, 0.42, 1.68, WOOD_L);
    b.rect(0.02, 0.12, 0.42, 1.68, WOOD_L);
    b.rect(-0.39, 0.2, 0.32, 0.7, "#00000022");
    b.rect(0.07, 0.2, 0.32, 0.7, "#00000022");
    b.circle(-0.06, 1.0, 0.025, GOLD);
    b.circle(0.06, 1.0, 0.025, GOLD);
    b.rect(-0.46, 0, 0.08, 0.06, WOOD_D);
    b.rect(0.38, 0, 0.08, 0.06, WOOD_D);
  }],
  bookshelf: [1.2, 1.96, 0, (b, rng) => {
    b.rect(-0.6, 0, 1.2, 1.96, WOOD_D);
    b.rect(-0.54, 0.06, 1.08, 1.84, "#2a1a10");
    const cols = ["#7a2a24", "#2c4a6e", "#3f5f2e", "#8a6a2a", "#5a3a5e", "#b08a4a", "#33302c"];
    for (let s = 0; s < 4; s++) {
      const y = 0.08 + s * 0.46;
      b.rect(-0.56, y - 0.04, 1.12, 0.04, WOOD_M);
      let x = -0.52;
      while (x < 0.48) {
        const w = 0.04 + rng() * 0.05;
        const h = 0.26 + rng() * 0.12;
        if (rng() < 0.12) {
          x += w;
          continue;
        }
        b.rect(x, y, Math.min(w, 0.52 - x), h, cols[Math.floor(rng() * cols.length)]);
        x += w + 0.006;
      }
    }
  }],
  shelf_jars: [1.5, 1.76, 0, (b, rng) => {
    b.rect(-0.75, 0, 0.06, 1.76, WOOD_D);
    b.rect(0.69, 0, 0.06, 1.76, WOOD_D);
    const jars = ["#4f8a5a", "#c98a3a", "#3a6a9a", "#9a3a4a", "#d8c890", "#6a4a8a", "#5aa0a0"];
    for (let s = 0; s < 4; s++) {
      const y = 0.12 + s * 0.42;
      b.rect(-0.72, y - 0.04, 1.44, 0.04, WOOD_M);
      let x = -0.64;
      while (x < 0.6) {
        const r = 0.05 + rng() * 0.05;
        const h = 0.12 + rng() * 0.16;
        const c = jars[Math.floor(rng() * jars.length)];
        b.rect(x, y, r * 2, h, c);
        b.rect(x + r * 0.5, y + h, r, 0.05, c);
        b.rect(x + r * 0.35, y + h + 0.05, r * 1.3, 0.025, WOOD_L);
        b.rect(x + r * 0.3, y + h * 0.35, r * 0.4, h * 0.45, "#ffffff40");
        x += r * 2 + 0.03 + rng() * 0.05;
      }
    }
  }],
  oven: [1.6, 1.9, 0, (b) => {
    b.rect(-0.8, 0, 1.6, 0.85, BRICK);
    b.ellipse(0, 0.85, 0.78, 0.62, BRICK);
    b.rect(0.28, 1.1, 0.26, 0.8, BRICK);
    b.bricks(-0.8, 0, 1.6, 0.85, 0.22, 0.11, "#5a2a1a");
    b.rect(-0.82, 0.82, 1.64, 0.06, STONE);
    b.arch(0, 0.9, 0.34, 0.28, "#1a0c06");
    b.glowArch(0, 0.9, 0.28, 0.2, EMBER, "fire");
    b.glowEllipse(0, 0.95, 0.18, 0.08, FLAME, "fire");
    b.rect(-0.78, 0.25, 0.4, 0.3, "#1a0c06");
    b.glowRect(-0.74, 0.27, 0.32, 0.08, EMBER, "fire");
  }],
  counter_bread: [1.9, 1.12, 0, (b) => {
    b.rect(-0.95, 0, 1.9, 0.86, WOOD_M);
    b.rect(-0.98, 0.86, 1.96, 0.07, WOOD_L);
    b.rect(-0.9, 0.08, 0.86, 0.7, "#00000022");
    b.rect(0.04, 0.08, 0.86, 0.7, "#00000022");
    const loaf = "#c98a45";
    b.ellipse(-0.68, 0.98, 0.17, 0.08, loaf);
    b.ellipse(-0.38, 0.99, 0.14, 0.09, "#b5763a");
    b.ellipse(-0.12, 0.97, 0.12, 0.06, loaf);
    b.rect(0.2, 0.93, 0.5, 0.14, "#9a7a4a");
    b.ellipse(0.3, 1.08, 0.08, 0.05, loaf);
    b.ellipse(0.47, 1.09, 0.08, 0.05, "#d89a55");
    b.ellipse(0.62, 1.07, 0.07, 0.045, loaf);
  }],
  workbench: [1.7, 1.86, 0, (b) => {
    b.rect(-0.82, 1.1, 1.64, 0.76, "#5a4a3a");
    b.rect(-0.78, 0, 0.08, 0.86, WOOD_D);
    b.rect(0.7, 0, 0.08, 0.86, WOOD_D);
    b.rect(-0.78, 0.25, 1.56, 0.06, WOOD_D);
    b.rect(-0.85, 0.86, 1.7, 0.1, WOOD_L);
    b.rect(0.5, 0.96, 0.2, 0.12, IRON);
    b.poly([[-0.65, 1.7], [-0.25, 1.7], [-0.25, 1.62], [-0.6, 1.5]], "#9a9aa0");
    b.rect(-0.7, 1.62, 0.08, 0.14, WOOD_M);
    b.rect(-0.1, 1.3, 0.03, 0.4, WOOD_M);
    b.rect(-0.15, 1.66, 0.13, 0.06, IRON);
    b.circle(0.35, 1.5, 0.16, "#8a7a5a");
    b.circle(0.35, 1.5, 0.06, "#5a4a3a");
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      b.rect(0.35 + Math.cos(a) * 0.17 - 0.02, 1.5 + Math.sin(a) * 0.17 - 0.02, 0.04, 0.04, "#8a7a5a");
    }
    b.rect(-0.4, 0.96, 0.3, 0.05, "#c9b58a");
  }],
  clock: [0.62, 2.06, 0, (b) => {
    b.rect(-0.22, 0, 0.44, 1.5, WOOD_M);
    b.rect(-0.28, 0, 0.56, 0.12, WOOD_D);
    b.rect(-0.28, 1.5, 0.56, 0.5, WOOD_D);
    b.poly([[-0.3, 2.0], [0.3, 2.0], [0, 2.06]], WOOD_D);
    b.circle(0, 1.74, 0.19, "#e8dfc4");
    b.rect(-0.006, 1.74, 0.012, 0.14, IRON);
    b.rect(0, 1.735, 0.1, 0.012, IRON);
    b.rect(-0.12, 0.3, 0.24, 1.0, "#2a1a10");
    b.rect(-0.008, 0.6, 0.016, 0.6, GOLD);
    b.circle(0, 0.6, 0.07, GOLD);
  }],
  forge: [1.7, 1.75, 0, (b) => {
    b.rect(-0.8, 0, 1.6, 0.8, STONE);
    b.bricks(-0.8, 0, 1.6, 0.8, 0.32, 0.2, STONE_D);
    b.rect(-0.7, 0.8, 1.4, 0.08, "#1a0c06");
    b.glowRect(-0.66, 0.8, 1.32, 0.1, EMBER, "fire");
    b.glowEllipse(-0.2, 0.92, 0.22, 0.08, FLAME, "fire");
    b.glowEllipse(0.25, 0.9, 0.18, 0.06, EMBER, "fire");
    b.poly([[-0.85, 1.15], [0.85, 1.15], [0.3, 1.75], [-0.3, 1.75]], STONE_D);
    b.rect(-0.85, 1.12, 1.7, 0.06, IRON);
  }],
  anvil: [0.9, 0.78, 0, (b) => {
    b.rect(-0.2, 0, 0.4, 0.42, WOOD_D);
    b.poly([[-0.14, 0.42], [0.14, 0.42], [0.1, 0.56], [-0.1, 0.56]], IRON);
    b.poly([[-0.45, 0.56], [0.3, 0.56], [0.3, 0.74], [-0.3, 0.74], [-0.45, 0.66]], "#45454c");
    b.rect(0.3, 0.6, 0.12, 0.12, "#45454c");
    b.rect(0.05, 0.74, 0.03, 0.04, "#8a8a92");
  }],
  bunk: [2.0, 1.86, 0, (b) => {
    b.rect(-1.0, 0, 0.08, 1.86, WOOD_D);
    b.rect(0.92, 0, 0.08, 1.86, WOOD_D);
    for (const y of [0.25, 1.15]) {
      b.rect(-0.96, y, 1.92, 0.12, WOOD_M);
      b.rect(-0.94, y + 0.12, 1.88, 0.12, LINEN);
      b.rect(-0.4, y + 0.08, 1.3, 0.2, "#4a5a3a");
      b.ellipse(-0.75, y + 0.28, 0.14, 0.06, "#e8e0cc");
    }
    for (let i = 0; i < 4; i++) b.rect(0.72, 0.4 + i * 0.22, 0.2, 0.035, WOOD_L);
  }],
  weapon_rack: [1.4, 1.8, 0, (b) => {
    b.rect(-0.7, 0, 1.4, 0.08, WOOD_D);
    b.rect(-0.7, 1.1, 1.4, 0.06, WOOD_D);
    b.rect(-0.66, 0, 0.06, 1.2, WOOD_D);
    b.rect(0.6, 0, 0.06, 1.2, WOOD_D);
    for (let i = 0; i < 4; i++) {
      const x = -0.5 + i * 0.16;
      b.rect(x, 0.08, 0.025, 1.55, WOOD_M);
      b.poly([[x - 0.02, 1.63], [x + 0.045, 1.63], [x + 0.0125, 1.8]], "#a9a9b2");
    }
    for (let i = 0; i < 2; i++) {
      const x = 0.15 + i * 0.16;
      b.rect(x, 0.35, 0.035, 0.9, "#b9b9c2");
      b.rect(x - 0.06, 0.3, 0.155, 0.04, GOLD);
      b.rect(x + 0.005, 0.1, 0.025, 0.2, WOOD_D);
    }
    b.circle(0.0, 0.5, 0.2, "#6a2a22");
    b.circle(0.0, 0.5, 0.06, GOLD);
  }],
  banner_red: [0.86, 1.6, 0.95, banner("#8a2224", GOLD)],
  banner_blue: [0.86, 1.6, 0.95, banner("#23407a", "#d8d0b8")],
  banner_gold: [0.86, 1.6, 0.95, banner("#e8dcc0", GOLD)],
  long_table: [2.6, 1.1, 0, (b) => {
    b.rect(-1.2, 0, 0.09, 0.68, WOOD_D);
    b.rect(1.11, 0, 0.09, 0.68, WOOD_D);
    b.rect(-0.05, 0, 0.1, 0.68, WOOD_D);
    b.rect(-1.3, 0.68, 2.6, 0.08, WOOD_M);
    for (const x of [-0.95, -0.45, 0.45, 0.95]) {
      b.ellipse(x, 0.78, 0.12, 0.025, "#c9c2b0");
      b.rect(x + 0.14, 0.76, 0.05, 0.08, GOLD);
      b.rect(x + 0.12, 0.84, 0.09, 0.06, GOLD);
    }
    b.rect(-0.05, 0.76, 0.1, 0.12, GOLD);
    candle(b, -0.04, 0.88, 0.14);
    candle(b, 0.04, 0.88, 0.1);
  }],
  barrels: [1.4, 1.0, 0, (b) => {
    for (const x of [-0.36, 0.36]) {
      b.rect(x - 0.3, 0.04, 0.6, 0.9, WOOD_M);
      b.ellipse(x, 0.49, 0.32, 0.45, WOOD_M);
      b.rect(x - 0.31, 0.2, 0.62, 0.05, IRON);
      b.rect(x - 0.31, 0.72, 0.62, 0.05, IRON);
      b.rect(x - 0.1, 0.1, 0.06, 0.8, "#00000022");
    }
    b.circle(-0.36, 0.45, 0.04, "#2a1a10");
  }],
  bar_counter: [2.3, 1.85, 0, (b) => {
    b.rect(-1.15, 1.2, 2.3, 0.04, WOOD_D);
    b.rect(-1.15, 1.55, 2.3, 0.04, WOOD_D);
    const bottles = ["#3f6a3a", "#6a2a2a", "#8a6a2a", "#2a3a5a"];
    for (let i = 0; i < 9; i++) {
      const x = -1.0 + i * 0.24;
      const c = bottles[i % bottles.length];
      b.rect(x, 1.24, 0.08, 0.2, c);
      b.rect(x + 0.025, 1.44, 0.03, 0.07, c);
      b.rect(x - 0.02, 1.59, 0.12, 0.14, i % 2 ? "#9a7a4a" : "#7a5a3a");
    }
    b.rect(-1.15, 0, 2.3, 1.0, WOOD_M);
    b.rect(-1.18, 1.0, 2.36, 0.08, WOOD_L);
    for (let i = 0; i < 5; i++) b.rect(-1.05 + i * 0.46, 0.1, 0.4, 0.8, "#00000022");
    for (const x of [-0.7, -0.2, 0.5]) {
      b.rect(x, 1.08, 0.12, 0.15, "#9a7048");
      b.rect(x + 0.12, 1.11, 0.04, 0.08, "#9a7048");
    }
  }],
  candelabra: [0.5, 1.62, 0, (b) => {
    b.poly([[-0.2, 0], [0.2, 0], [0.06, 0.1], [-0.06, 0.1]], GOLD);
    b.rect(-0.025, 0.1, 0.05, 1.2, GOLD);
    b.rect(-0.2, 1.28, 0.4, 0.04, GOLD);
    candle(b, -0.18, 1.32, 0.16);
    candle(b, 0.0, 1.32, 0.2);
    candle(b, 0.18, 1.32, 0.16);
  }],
  altar: [1.7, 1.55, 0, (b) => {
    b.rect(-0.8, 0, 1.6, 0.95, "#b8b0a0");
    b.rect(-0.84, 0.95, 1.68, 0.06, "#d8d0c0");
    b.rect(-0.7, 0.3, 1.4, 0.66, "#f0ead8");
    b.rect(-0.7, 0.3, 1.4, 0.06, GOLD);
    b.rect(-0.08, 0.4, 0.16, 0.4, GOLD);
    b.rect(-0.03, 1.01, 0.06, 0.18, GOLD);
    b.circle(0, 1.34, 0.17, GOLD);
    b.circle(0, 1.34, 0.08, "#f6e2a0");
    b.rect(-0.45, 1.01, 0.08, 0.1, GOLD);
    b.rect(0.37, 1.01, 0.08, 0.1, GOLD);
    candle(b, -0.41, 1.11, 0.18);
    candle(b, 0.41, 1.11, 0.18);
    b.rect(-0.62, 1.01, 0.1, 0.06, "#c99a3a");
    b.rect(0.52, 1.01, 0.1, 0.06, "#c99a3a");
  }],
  pew: [2.3, 0.98, 0, (b) => {
    b.rect(-1.15, 0, 0.08, 0.98, WOOD_D);
    b.rect(1.07, 0, 0.08, 0.98, WOOD_D);
    b.rect(-1.1, 0.42, 2.2, 0.07, WOOD_M);
    b.rect(-1.1, 0.6, 2.2, 0.32, WOOD_M);
    b.rect(-1.1, 0.88, 2.2, 0.04, WOOD_L);
  }],
  crates: [1.9, 1.7, 0, (b) => {
    const crate = (x, y, s, c) => {
      b.rect(x, y, s, s, c);
      b.rect(x, y, s, 0.06, WOOD_D);
      b.rect(x, y + s - 0.06, s, 0.06, WOOD_D);
      b.rect(x, y, 0.06, s, WOOD_D);
      b.rect(x + s - 0.06, y, 0.06, s, WOOD_D);
      b.poly([[x + 0.06, y + 0.06], [x + 0.14, y + 0.06], [x + s - 0.06, y + s - 0.14], [x + s - 0.06, y + s - 0.06], [x + s - 0.14, y + s - 0.06], [x + 0.06, y + 0.14]], WOOD_D);
    };
    crate(-0.95, 0, 0.8, WOOD_L);
    crate(-0.1, 0, 0.7, "#9a7046");
    crate(0.6, 0, 0.35, WOOD_L);
    crate(-0.75, 0.8, 0.62, "#9a7046");
    crate(-0.05, 0.7, 0.5, WOOD_L);
  }],
  sacks: [1.3, 0.8, 0, (b) => {
    b.ellipse(-0.36, 0.3, 0.3, 0.3, "#a8905e");
    b.ellipse(0.3, 0.27, 0.32, 0.27, "#b89e6a");
    b.ellipse(-0.02, 0.55, 0.26, 0.24, "#9e8656");
    b.rect(-0.08, 0.74, 0.12, 0.06, "#8a7448");
    b.rect(-0.42, 0.55, 0.12, 0.05, "#8a7448");
  }],
  fireplace: [1.5, 1.5, 0, (b) => {
    b.rect(-0.75, 0, 1.5, 1.32, STONE);
    b.bricks(-0.75, 0, 1.5, 1.32, 0.3, 0.18, STONE_D);
    b.rect(-0.82, 1.3, 1.64, 0.1, WOOD_D);
    b.arch(0, 0.08, 0.46, 0.75, "#120804");
    b.rect(-0.3, 0.08, 0.6, 0.08, WOOD_D);
    b.glowEllipse(0, 0.22, 0.3, 0.12, EMBER, "fire");
    b.glowPoly([[-0.2, 0.18], [0.2, 0.18], [0.1, 0.42], [0.03, 0.62], [-0.06, 0.4], [-0.14, 0.5]], FLAME, "fire");
    b.rect(-0.5, 1.4, 0.12, 0.1, "#c9a060");
    b.rect(0.35, 1.4, 0.1, 0.06, "#7a8aa0");
  }],
  painting: [0.82, 0.64, 1.35, (b) => {
    b.rect(-0.41, 0, 0.82, 0.64, "#7a5a2a");
    b.rect(-0.35, 0.06, 0.7, 0.52, "#8fb0c8");
    b.poly([[-0.35, 0.06], [-0.35, 0.3], [-0.1, 0.42], [0.12, 0.28], [0.35, 0.36], [0.35, 0.06]], "#5a7a46");
    b.poly([[-0.35, 0.06], [-0.35, 0.16], [0.35, 0.2], [0.35, 0.06]], "#46603a");
    b.circle(0.2, 0.46, 0.05, "#f0e0a0");
  }],
  mirror: [0.56, 0.86, 1.15, (b) => {
    b.ellipse(0, 0.43, 0.28, 0.43, GOLD);
    b.ellipse(0, 0.43, 0.22, 0.36, "#b8cad6");
    b.poly([[-0.12, 0.6], [-0.04, 0.68], [0.1, 0.3], [0.02, 0.22]], "#e8f0f6");
  }],
  person: [0.62, 1.72, 0, (b) => {
    const c = "#2b2430";
    b.circle(0, 1.6, 0.11, c);
    b.rect(-0.05, 1.44, 0.1, 0.06, c);
    b.poly([[-0.2, 1.46], [0.2, 1.46], [0.24, 0.9], [0.28, 0.0], [-0.28, 0.0], [-0.24, 0.9]], c);
    b.poly([[-0.2, 1.44], [-0.3, 1.0], [-0.24, 0.8], [-0.18, 1.0]], c);
    b.poly([[0.2, 1.44], [0.3, 1.0], [0.24, 0.8], [0.18, 1.0]], c);
    b.rect(-0.2, 0.9, 0.4, 0.05, "#4a3a2a");
  }],
  shelf_plates: [1.24, 0.56, 1.45, (b) => {
    b.rect(-0.62, 0.2, 1.24, 0.05, WOOD_M);
    b.poly([[-0.5, 0.2], [-0.42, 0.2], [-0.5, 0.06]], WOOD_D);
    b.poly([[0.5, 0.2], [0.42, 0.2], [0.5, 0.06]], WOOD_D);
    for (const x of [-0.4, -0.12, 0.16]) {
      b.ellipse(x, 0.37, 0.12, 0.12, "#c9c0a8");
      b.ellipse(x, 0.37, 0.085, 0.085, "#e2dccb");
      b.rect(x - 0.1, 0.36, 0.2, 0.012, "#5a7aa8");
    }
    b.rect(0.34, 0.25, 0.1, 0.12, "#9a5a3a");
    b.rect(0.48, 0.25, 0.08, 0.16, "#5a7a4a");
  }],
  notice_board: [1.3, 1.0, 1.0, (b, rng) => {
    b.rect(-0.65, 0, 1.3, 1.0, WOOD_D);
    b.rect(-0.59, 0.06, 1.18, 0.88, "#a07a50");
    for (let i = 0; i < 7; i++) {
      const x = -0.52 + rng() * 0.8;
      const y = 0.1 + rng() * 0.5;
      b.rect(x, y, 0.2 + rng() * 0.1, 0.22 + rng() * 0.08, rng() < 0.7 ? "#e8dfc4" : "#d8c890");
      b.circle(x + 0.1, y + 0.26, 0.015, "#8a2a2a");
    }
  }],
  stairs: [1.8, 2.55, 0, (b) => {
    for (let i = 0; i < 11; i++) b.rect(-0.9 + i * 0.16, 0, 0.16, 0.23 * (i + 1), i % 2 ? WOOD_M : "#5e3b22");
    b.poly([[-0.9, 0.0], [0.9, 2.55], [0.9, 2.4], [-0.9, -0.15]], WOOD_D);
    b.poly([[-0.9, 0.95], [0.9, 3.0], [0.9, 2.94], [-0.9, 0.89]], WOOD_D);
    for (let i = 0; i < 7; i++) {
      const x = -0.85 + i * 0.27;
      const y = (x + 0.9) * (2.55 / 1.8);
      b.rect(x, y, 0.03, 0.9, WOOD_D);
    }
  }],
  coat_rack: [0.64, 1.86, 0, (b) => {
    b.rect(-0.2, 0, 0.4, 0.05, WOOD_D);
    b.rect(-0.025, 0, 0.05, 1.82, WOOD_D);
    b.rect(-0.18, 1.72, 0.36, 0.035, WOOD_D);
    b.poly([[-0.04, 1.7], [-0.3, 1.62], [-0.32, 0.7], [-0.04, 0.78]], "#4a3a5a");
    b.ellipse(0.12, 1.72, 0.13, 0.05, "#5a4430");
    b.rect(0.06, 1.72, 0.12, 0.1, "#5a4430");
  }],
  chest: [1.0, 0.7, 0, (b) => {
    b.rect(-0.5, 0, 1.0, 0.48, WOOD_M);
    b.ellipse(0, 0.48, 0.5, 0.2, WOOD_M);
    b.rect(-0.5, 0.46, 1.0, 0.04, IRON);
    b.rect(-0.4, 0, 0.06, 0.66, IRON);
    b.rect(0.34, 0, 0.06, 0.66, IRON);
    b.rect(-0.06, 0.36, 0.12, 0.14, GOLD);
  }],
  trophies: [1.24, 0.88, 1.4, (b) => {
    b.poly([[-0.55, 0.05], [-0.49, 0.0], [0.55, 0.83], [0.49, 0.88]], "#b9b9c2");
    b.poly([[0.55, 0.05], [0.49, 0.0], [-0.55, 0.83], [-0.49, 0.88]], "#b9b9c2");
    b.rect(-0.5, 0.1, 0.12, 0.04, GOLD);
    b.rect(0.38, 0.1, 0.12, 0.04, GOLD);
    b.poly([[-0.24, 0.8], [0.24, 0.8], [0.24, 0.4], [0, 0.12], [-0.24, 0.4]], "#2f4a7a");
    b.poly([[-0.24, 0.8], [0.24, 0.8], [0.24, 0.72], [-0.24, 0.72]], GOLD);
    b.poly([[0, 0.66], [0.1, 0.45], [0, 0.24], [-0.1, 0.45]], GOLD);
  }],
  plant: [0.5, 0.9, 0, (b) => {
    b.poly([[-0.14, 0], [0.14, 0], [0.18, 0.3], [-0.18, 0.3]], "#9a5a3a");
    b.ellipse(0, 0.5, 0.2, 0.24, "#3f6a34");
    b.ellipse(-0.12, 0.66, 0.1, 0.16, "#4f7a3a");
    b.ellipse(0.12, 0.7, 0.1, 0.18, "#355e2c");
    b.ellipse(0, 0.8, 0.08, 0.1, "#4f7a3a");
  }],
  dresser: [1.2, 1.2, 0, (b) => {
    b.rect(-0.6, 0.06, 1.2, 0.8, WOOD_M);
    b.rect(-0.63, 0.86, 1.26, 0.05, WOOD_L);
    for (let i = 0; i < 3; i++) {
      b.rect(-0.54, 0.12 + i * 0.25, 1.08, 0.2, WOOD_L);
      b.circle(0, 0.22 + i * 0.25, 0.02, GOLD);
    }
    b.rect(-0.58, 0, 0.08, 0.06, WOOD_D);
    b.rect(0.5, 0, 0.08, 0.06, WOOD_D);
    b.rect(-0.4, 0.91, 0.12, 0.14, "#5a7a9a");
    b.ellipse(0.1, 0.93, 0.1, 0.02, "#c9c2b0");
    candle(b, 0.35, 0.91, 0.1);
  }],
});

// --------------------------------------------------------------------------------------------
// Estilos de cômodo (fonte única: um estilo novo é uma entrada aqui, sem mexer no shader)
// walls/papers: escolhidos por prédio+andar (cômodos vizinhos combinam); móveis por janela.
// decor: na parede do fundo; back/mid/front: cartões em profundidades crescentes para a janela.
// lamp: [cor, intensidade, posição 'table' | 'ceiling' | 'hearth']; fire: brasas sempre acesas.
// --------------------------------------------------------------------------------------------
const ROOM_STYLES = Object.freeze({
  casa: {
    walls: ["#d9c7a3", "#cdb48a", "#bcc4a6", "#d6bba6", "#c8b8a0"],
    papers: [PAPER.plaster, PAPER.stripes, PAPER.damask, PAPER.timber],
    floor: ["#7a5236", "#8b6142", "#6e4a30"], floorPattern: FLOOR.planks,
    decor: ["painting", "mirror", "shelf_plates", null],
    back: ["wardrobe", "fireplace", "bookshelf", "dresser"],
    mid: ["table", "table", null],
    front: [null, "chair", "plant", "person"],
    curtains: ["#8c3a2e", "#3e5a7c", "#6e7a3c", "#a07a3a"], curtainChance: 0.75,
    lamp: ["#ffb565", 1.0, "table"], fire: 0,
  },
  quarto: {
    walls: ["#d8c6aa", "#c9b8c8", "#b8c8c0", "#d8c0a0"],
    papers: [PAPER.stripes, PAPER.damask, PAPER.plaster, PAPER.timber],
    floor: ["#7a5236", "#8b6142"], floorPattern: FLOOR.planks,
    decor: ["painting", "mirror", null],
    back: ["bed", "bed_blue", "bed"],
    mid: [null, "dresser", "chair", null],
    front: [null, null, "person", "plant"],
    curtains: ["#9a4a5a", "#4a6a8a", "#8a7a4a", "#5a7a5a"], curtainChance: 0.85,
    lamp: ["#ffbe78", 0.85, "table"], fire: 0,
  },
  padaria: {
    walls: ["#e2cfa8", "#d8c49a"], papers: [PAPER.plaster, PAPER.timber],
    floor: ["#8a7a68", "#9a8a72"], floorPattern: FLOOR.flags,
    decor: ["shelf_plates", null],
    back: ["oven"],
    mid: ["counter_bread", "table"],
    front: [null, "sacks", "person"],
    curtains: ["#c8b890"], curtainChance: 0.3,
    lamp: ["#ffae58", 1.1, "hearth"], fire: 1,
  },
  botica: {
    walls: ["#a9b89a", "#c2b58e", "#9fb0a8"], papers: [PAPER.plaster, PAPER.planks],
    floor: ["#6e4a30", "#5e4028"], floorPattern: FLOOR.planks,
    decor: ["painting", null],
    back: ["shelf_jars", "shelf_jars", "bookshelf"],
    mid: ["table", "counter_bread"],
    front: [null, "plant", "person"],
    curtains: ["#5a7a4a", "#6a4a7a"], curtainChance: 0.6,
    lamp: ["#ffc77a", 0.9, "table"], fire: 0,
  },
  oficina: {
    walls: ["#b8a080", "#a89478"], papers: [PAPER.planks, PAPER.plaster],
    floor: ["#6a4a30", "#5a4028"], floorPattern: FLOOR.planks,
    decor: [null, "shelf_plates"],
    back: ["clock", "workbench", "bookshelf"],
    mid: ["workbench", "table"],
    front: [null, "chair", "crates"],
    curtains: ["#7a6a4a"], curtainChance: 0.25,
    lamp: ["#ffbf70", 1.0, "ceiling"], fire: 0,
  },
  forja: {
    walls: ["#6e6862", "#7a7068"], papers: [PAPER.stone],
    floor: ["#4a4038", "#55493e"], floorPattern: FLOOR.dirt,
    decor: ["trophies", null],
    back: ["forge"],
    mid: ["anvil", "barrels"],
    front: [null, "barrels", "person"],
    curtains: ["#3a3a3a"], curtainChance: 0.0,
    lamp: ["#ff8a3a", 1.3, "hearth"], fire: 1,
  },
  taverna: {
    walls: ["#c8a87a", "#b89870"], papers: [PAPER.timber, PAPER.planks],
    floor: ["#6a4428", "#5a3a22"], floorPattern: FLOOR.planks,
    decor: ["shelf_plates", "trophies", "painting"],
    back: ["bar_counter", "barrels", "fireplace"],
    mid: ["long_table", "table"],
    front: ["person", "chair", null],
    curtains: ["#8a3a2a", "#6a5a2a"], curtainChance: 0.5,
    lamp: ["#ffa851", 1.25, "ceiling"], fire: 0,
  },
  guilda: {
    walls: ["#c8b490", "#b8a888"], papers: [PAPER.timber, PAPER.damask],
    floor: ["#7a5236", "#6a4a30"], floorPattern: FLOOR.planks,
    decor: ["notice_board", "trophies", "banner_blue"],
    back: ["bookshelf", "weapon_rack", "chest"],
    mid: ["long_table", "table"],
    front: [null, "person", "chair"],
    curtains: ["#2f4a7a", "#6a2a22"], curtainChance: 0.5,
    lamp: ["#ffb868", 1.1, "ceiling"], fire: 0,
  },
  templo: {
    walls: ["#d8d2c4", "#cfc8b8"], papers: [PAPER.stone, PAPER.plaster],
    floor: ["#d8d0c0", "#c8c0b0"], floorPattern: FLOOR.checker,
    decor: ["banner_gold", "banner_red"],
    back: ["altar"],
    mid: ["candelabra", null],
    front: ["pew", "pew", "candelabra"],
    curtains: ["#e8dcc0"], curtainChance: 0.2,
    lamp: ["#ffd890", 1.15, "hearth"], fire: 0,
  },
  quartel: {
    walls: ["#8a847a", "#9a9286"], papers: [PAPER.stone, PAPER.planks],
    floor: ["#5e4630", "#6a5038"], floorPattern: FLOOR.planks,
    decor: ["banner_red", "trophies", null],
    back: ["bunk", "bunk", "weapon_rack"],
    mid: ["weapon_rack", "table", null],
    front: [null, "chest", "person"],
    curtains: ["#5a5a4a"], curtainChance: 0.15,
    lamp: ["#ffb060", 0.95, "ceiling"], fire: 0,
  },
  salao: {
    walls: ["#8a3a34", "#6e3440", "#7a5a3a"], papers: [PAPER.damask, PAPER.stripes],
    floor: ["#c8c0b0", "#5a3a24"], floorPattern: FLOOR.checker,
    decor: ["banner_red", "banner_gold", "painting"],
    back: ["fireplace", "bookshelf"],
    mid: ["long_table"],
    front: [null, "chair", "candelabra", "person"],
    curtains: ["#6a1a1e", "#c9a03a"], curtainChance: 0.9,
    lamp: ["#ffc070", 1.3, "ceiling"], fire: 1,
  },
  armazem: {
    walls: ["#9a8462", "#8a7458"], papers: [PAPER.planks],
    floor: ["#5e5040", "#6a5a46"], floorPattern: FLOOR.dirt,
    decor: [null],
    back: ["crates", "barrels"],
    mid: ["crates", "barrels", "sacks"],
    front: ["sacks", null, "barrels"],
    curtains: ["#5a4a3a"], curtainChance: 0.0,
    lamp: ["#ffb060", 0.7, "ceiling"], fire: 0,
  },
});
// Vestíbulo atrás das portas trancadas: herda cores do estilo do cômodo e troca a mobília
const ENTRY_LAYOUT = Object.freeze({
  decor: ["painting", "mirror", "shelf_plates"],
  back: ["stairs", "stairs", "wardrobe"],
  mid: [null, "coat_rack", "chest"],
  front: [null],
});

const SPRITE_NAMES = Object.keys(SPRITE_DEFS);
const SPRITE_INDEX = new Map(SPRITE_NAMES.map((n, i) => [n, i]));
const PERSON_SWAY = 0.55;          // m de vaivém da silhueta que anda pela sala
const ATLAS_PAD = 4;                // px de respiro entre células (mipmaps não vazam)

// --------------------------------------------------------------------------------------------
// Pincel em metros sobre o canvas: cor em 'c', máscara emissiva em 'g' (vermelho 255 = fogo,
// 128 = vela). Emissivo também é pintado na cor (o shader soma a cor como emissão).
// --------------------------------------------------------------------------------------------
class Brush {
  constructor(color, glow) {
    this.c = color;
    this.g = glow;
  }

  static glowStyle(kind) {
    return kind === "fire" ? "rgb(255,0,0)" : "rgb(128,0,0)";
  }

  fillOn(ctx, fill, path) {
    ctx.fillStyle = fill;
    ctx.beginPath();
    path(ctx);
    ctx.fill();
  }

  rect(x, y, w, h, fill) {
    this.c.fillStyle = fill;
    this.c.fillRect(x, y, w, h);
  }

  circle(x, y, r, fill) {
    this.ellipse(x, y, r, r, fill);
  }

  ellipse(x, y, rx, ry, fill) {
    this.fillOn(this.c, fill, (ctx) => ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2));
  }

  poly(pts, fill) {
    this.fillOn(this.c, fill, (ctx) => {
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
    });
  }

  // Arco (porta de forno/lareira): retângulo com semicírculo no topo; base em y, raio r, altura h
  arch(x, y, r, h, fill) {
    this.fillOn(this.c, fill, (ctx) => Brush.archPath(ctx, x, y, r, h));
  }

  static archPath(ctx, x, y, r, h) {
    const spring = y + Math.max(0, h - r);
    ctx.moveTo(x - r, y);
    ctx.lineTo(x - r, spring);
    ctx.arc(x, spring, r, Math.PI, 0, true);
    ctx.lineTo(x + r, y);
    ctx.closePath();
  }

  // Fiadas de tijolo/pedra: só as juntas (o fundo já foi pintado)
  bricks(x, y, w, h, bw, bh, mortar) {
    this.c.fillStyle = mortar;
    const rows = Math.floor(h / bh);
    for (let r = 0; r <= rows; r++) {
      const yy = y + r * bh;
      this.c.fillRect(x, yy, w, 0.012);
      const off = (r % 2) * bw * 0.5;
      for (let xx = x + off; xx < x + w; xx += bw) this.c.fillRect(xx, yy, 0.012, Math.min(bh, y + h - yy));
    }
  }

  glowRect(x, y, w, h, fill, kind) {
    this.rect(x, y, w, h, fill);
    this.g.fillStyle = Brush.glowStyle(kind);
    this.g.fillRect(x, y, w, h);
  }

  glowEllipse(x, y, rx, ry, fill, kind) {
    const path = (ctx) => ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    this.fillOn(this.c, fill, path);
    this.fillOn(this.g, Brush.glowStyle(kind), path);
  }

  glowPoly(pts, fill, kind) {
    const path = (ctx) => {
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
    };
    this.fillOn(this.c, fill, path);
    this.fillOn(this.g, Brush.glowStyle(kind), path);
  }

  glowArch(x, y, r, h, fill, kind) {
    const path = (ctx) => Brush.archPath(ctx, x, y, r, h);
    this.fillOn(this.c, fill, path);
    this.fillOn(this.g, Brush.glowStyle(kind), path);
  }
}

function mulberry32(a) {
  let s = a >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Atlas RGBA (DataTexture): alfa 0 = vazio, ~0,6 = difuso, ~0,85 = vela (só com lâmpada), 1 = fogo
function buildAtlas() {
  const tile = CONFIG.interiors.atlasTile;
  const cols = 8;
  const rows = Math.ceil(SPRITE_NAMES.length / cols);
  const W = cols * tile;
  const H = rows * tile;
  const color = document.createElement("canvas");
  const glow = document.createElement("canvas");
  color.width = glow.width = W;
  color.height = glow.height = H;
  const c = color.getContext("2d", { willReadFrequently: true });
  const g = glow.getContext("2d", { willReadFrequently: true });
  const brush = new Brush(c, g);
  const meta = new Float32Array(SPRITE_NAMES.length * 4);
  const rng = mulberry32(0xa1b0c);
  SPRITE_NAMES.forEach((name, i) => {
    const [w, h, mount, draw] = SPRITE_DEFS[name];
    const col = i % cols;
    const row = Math.floor(i / cols);
    const size = Math.max(w, h);
    const s = (tile - 2 * ATLAS_PAD) / size;
    const ox = col * tile + tile * 0.5;
    const oy = row * tile + tile - ATLAS_PAD;
    c.save();
    g.save();
    c.beginPath();
    c.rect(col * tile, row * tile, tile, tile);
    c.clip();
    g.beginPath();
    g.rect(col * tile, row * tile, tile, tile);
    g.clip();
    c.setTransform(s, 0, 0, -s, ox, oy);
    g.setTransform(s, 0, 0, -s, ox, oy);
    draw(brush, rng);
    // Sombreado vertical (base mais escura): dá volume às silhuetas
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = "source-atop";
    const grad = c.createLinearGradient(0, row * tile, 0, row * tile + tile);
    grad.addColorStop(0, "rgba(255,240,220,0.10)");
    grad.addColorStop(1, "rgba(0,0,0,0.30)");
    c.fillStyle = grad;
    c.fillRect(col * tile, row * tile, tile, tile);
    c.globalCompositeOperation = "source-over";
    c.restore();
    g.restore();
    // (coluna, linha, metros por célula, altura de montagem)
    meta.set([col, row, tile / s, mount], i * 4);
  });
  const src = c.getImageData(0, 0, W, H).data;
  const em = g.getImageData(0, 0, W, H).data;
  const out = new Uint8Array(W * H * 4);
  for (let p = 0; p < W * H; p++) {
    const k = p * 4;
    const a = src[k + 3];
    out[k] = src[k];
    out[k + 1] = src[k + 1];
    out[k + 2] = src[k + 2];
    if (em[k + 3] > 127 && a > 0) out[k + 3] = em[k] > 200 ? 255 : 217;
    else out[k + 3] = Math.round(a * 0.6);
  }
  // Dilata a cor para dentro dos pixels vazios: mipmaps não escurecem as bordas das silhuetas
  const filled = (k) => out[k + 3] !== 0 || (out[k] | out[k + 1] | out[k + 2]) !== 0;
  for (let pass = 0; pass < 4; pass++) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const k = (y * W + x) * 4;
        if (filled(k)) continue;
        const n = x > 0 && filled(k - 4) ? k - 4 : x < W - 1 && filled(k + 4) ? k + 4 : y > 0 && filled(k - W * 4) ? k - W * 4 : y < H - 1 && filled(k + W * 4) ? k + W * 4 : -1;
        if (n < 0) continue;
        out[k] = out[n];
        out[k + 1] = out[n + 1];
        out[k + 2] = out[n + 2];
      }
    }
  }
  const tex = new THREE.DataTexture(out, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return { texture: tex, meta, grid: new THREE.Vector2(cols, rows), padFrac: ATLAS_PAD / tile };
}

// --------------------------------------------------------------------------------------------
// Shaders
// --------------------------------------------------------------------------------------------
const ROOM_VERTEX = /* glsl */ `
  attribute vec4 aFrame;    // origem da sala (x, y do piso, z no plano do vidro) + rotação r do lado
  attribute vec4 aRoom;     // xL, xR, altura, profundidade
  attribute vec4 aGlass;    // centro y do vão, meia-largura, meia-altura, tipo + 2*espelho
  attribute vec4 aWall;     // cor + padrão do papel de parede
  attribute vec4 aFloor;    // cor + padrão do piso
  attribute vec4 aAccent;   // cor da cortina + quanto ela fecha
  attribute vec4 aLamp;     // cor + intensidade da lâmpada
  attribute vec4 aLampPos;  // posição da lâmpada na sala + semente
  attribute vec4 aCard0;    // sprite, x, profundidade, vaivém
  attribute vec4 aCard1;
  attribute vec4 aCard2;
  attribute vec4 aDecor;    // sprite da parede do fundo, x, brasas sempre acesas, -
  attribute vec2 aState;    // janela: abertura 0..1 | porta: giro da folha (rad); lâmpada 0..1
  uniform float uTime;
  varying vec4 vA;          // ponto no vidro (x, y) + direção do raio (x, y)
  varying vec4 vB;          // direção z, xL, xR, altura
  varying vec4 vC;          // profundidade, centro y do vão, meia-largura, meia-altura
  varying vec4 vD;          // tipo, semente, estado
  varying vec4 vWall;
  varying vec4 vFloor;
  varying vec4 vAccent;
  varying vec4 vLamp;
  varying vec4 vLampPos;
  varying vec4 vCard0;      // .w = sprite da parede do fundo
  varying vec4 vCard1;      // .w = x do sprite da parede do fundo
  varying vec4 vCard2;      // .w = brasas sempre acesas
  #include <fog_pars_vertex>
  void main() {
    float c = cos(aFrame.w);
    float s = sin(aFrame.w);
    vec3 T = vec3(s, 0.0, c);
    vec3 N = vec3(c, 0.0, -s);
    vec3 rel = position - aFrame.xyz;
    vec3 cam = cameraPosition - aFrame.xyz;
    float mirror = aGlass.w > 1.5 ? -1.0 : 1.0;
    vec3 pl = vec3(dot(rel, T) * mirror, rel.y, -dot(rel, N));
    vec3 cl = vec3(dot(cam, T) * mirror, cam.y, -dot(cam, N));
    vec3 dir = pl - cl;
    vA = vec4(pl.xy, dir.xy);
    vB = vec4(dir.z, aRoom.xyz);
    vC = vec4(aRoom.w, aGlass.xyz);
    vD = vec4(mod(aGlass.w, 2.0), aLampPos.w, aState);
    vWall = aWall;
    vFloor = aFloor;
    vAccent = aAccent;
    vLamp = aLamp;
    vLampPos = vec4(aLampPos.xyz, aLampPos.w);
    float walk = sin(uTime * 0.21 + aLampPos.w * 37.0);
    vCard0 = vec4(aCard0.x, aCard0.y + walk * aCard0.w, aCard0.z, aDecor.x);
    vCard1 = vec4(aCard1.x, aCard1.y + walk * aCard1.w, aCard1.z, aDecor.y);
    vCard2 = vec4(aCard2.x, aCard2.y + walk * aCard2.w, aCard2.z, aDecor.z);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;

function roomFragment(spriteCount) {
  return /* glsl */ `
  uniform sampler2D uAtlas;
  uniform vec4 uSprites[${spriteCount}];
  uniform vec2 uGrid;
  uniform float uPad;
  uniform float uNight;
  uniform float uTime;
  uniform float uDayAmb;
  uniform float uNightAmb;
  uniform float uLampGain;
  uniform float uGlass;
  uniform float uHingeZ;
  uniform vec2 uPatternFade;
  varying vec4 vA;
  varying vec4 vB;
  varying vec4 vC;
  varying vec4 vD;
  varying vec4 vWall;
  varying vec4 vFloor;
  varying vec4 vAccent;
  varying vec4 vLamp;
  varying vec4 vLampPos;
  varying vec4 vCard0;
  varying vec4 vCard1;
  varying vec4 vCard2;
  #include <fog_pars_fragment>

  float hash1(float n) { return fract(sin(n) * 43758.5453); }
  float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  // Sprite do atlas num plano: d = (x relativo ao centro do sprite, y do piso) em metros.
  // Sem desvio de fluxo (amostra sempre): derivadas válidas para o mipmap.
  vec4 sprite(float id, vec2 d) {
    vec4 sp = uSprites[int(max(id, 0.0))];
    vec2 t = vec2(0.5 + d.x / sp.z, 1.0 - uPad - (d.y - sp.w) / sp.z);
    float inside = step(0.0, id) * step(0.0, t.x) * step(t.x, 1.0) * step(0.0, t.y) * step(t.y, 1.0);
    return texture2D(uAtlas, (sp.xy + clamp(t, 0.0, 1.0)) / uGrid) * inside;
  }

  vec3 wallAlbedo(vec2 w, vec3 base, float pat, float detail) {
    vec3 c = base;
    float plaster = 0.95 + 0.05 * sin(w.x * 3.1 + sin(w.y * 2.3) * 2.0) * sin(w.y * 4.7 + w.x * 1.3);
    if (pat < 0.5) {
      c *= mix(1.0, plaster, detail);
    } else if (pat < 1.5) {
      c *= mix(0.93, 0.86 + 0.14 * step(0.5, fract(w.x * 3.5)), detail);
    } else if (pat < 2.5) {
      vec2 q = abs(fract(w * vec2(3.2, 2.4)) - 0.5);
      c *= 1.0 - 0.14 * step(q.x + q.y, 0.2) * detail;
    } else if (pat < 3.5) {
      float row = floor(w.y / 0.32);
      vec2 b = vec2(w.x / 0.62 + row * 0.5, w.y / 0.32);
      vec2 f = fract(b);
      float mortar = min(step(f.x, 0.05) + step(f.y, 0.08), 1.0);
      return c * mix(0.88, (0.8 + 0.2 * hash2(floor(b))) * (1.0 - 0.45 * mortar), detail);
    } else if (pat < 4.5) {
      float k = floor(w.x / 0.17);
      return c * mix(0.86, (0.78 + 0.22 * hash1(k * 7.1)) * (1.0 - 0.5 * step(0.94, fract(w.x / 0.17))), detail);
    } else {
      float beam = max(step(abs(fract(w.x / 1.3) - 0.5), 0.055), step(abs(w.y - 1.15), 0.07));
      c = mix(c * mix(1.0, plaster, detail), vec3(0.075, 0.042, 0.024), beam);
    }
    // Lambri, rodapé e moldura (cômodos de reboco/papel)
    float wain = step(w.y, 0.85);
    vec3 panel = vec3(0.13, 0.075, 0.042) * (1.0 - 0.18 * step(0.5, fract(w.x * 2.2)) * detail);
    c = mix(c, panel, wain);
    c *= 1.0 - 0.4 * step(w.y, 0.1);
    c *= 1.0 - 0.45 * step(abs(w.y - 0.86), 0.025);
    return c;
  }

  vec3 floorAlbedo(vec2 f, vec3 base, float pat, float detail) {
    if (pat < 0.5) {
      float k = floor(f.x / 0.2);
      float o = hash1(k * 3.3);
      float j = floor(f.y / 1.1 + o);
      float gap = min(step(0.95, fract(f.x / 0.2)) + step(0.985, fract(f.y / 1.1 + o)), 1.0);
      return base * mix(0.86, (0.74 + 0.26 * hash2(vec2(k, j))) * (1.0 - 0.45 * gap), detail);
    } else if (pat < 1.5) {
      float row = floor(f.y / 0.55);
      vec2 b = vec2(f.x / 0.7 + row * 0.37, f.y / 0.55);
      vec2 fr = fract(b);
      float m = min(step(fr.x, 0.04) + step(fr.y, 0.05), 1.0);
      return base * mix(0.86, (0.78 + 0.22 * hash2(floor(b))) * (1.0 - 0.5 * m), detail);
    } else if (pat < 2.5) {
      vec2 b = floor(f / 0.5);
      return base * mix(0.72, mix(0.42, 1.0, mod(b.x + b.y, 2.0)), detail);
    }
    return base * mix(0.9, (0.8 + 0.2 * hash2(floor(f * 13.0))) * (0.9 + 0.1 * hash2(floor(f * 3.0))), detail);
  }

  void main() {
    vec3 ro = vec3(vA.x, max(vA.y, 0.001), 0.0);
    vec3 rd = vec3(vA.zw, vB.x);
    rd.x = abs(rd.x) < 1e-4 ? 1e-4 : rd.x;
    rd.y = abs(rd.y) < 1e-4 ? 1e-4 : rd.y;
    float xL = vB.y;
    float xR = vB.z;
    float H = vB.w;
    float D = vC.x;
    float kind = vD.x;
    float seed = vD.y;
    float lampState = vD.w;

    // Caixa: raio saindo do vidro (z = 0) para dentro; a primeira face atingida
    vec3 inv = 1.0 / rd;
    float tx = ((rd.x > 0.0 ? xR : xL) - ro.x) * inv.x;
    float ty = ((rd.y > 0.0 ? H : 0.0) - ro.y) * inv.y;
    float tz = (D - ro.z) * inv.z;
    float t = min(min(tx, ty), tz);
    vec3 p = ro + rd * t;
    float camDist = length(rd) * (1.0 + t);
    float detail = 1.0 - smoothstep(uPatternFade.x, uPatternFade.y, camDist);

    vec3 n;
    vec3 alb;
    float ao;
    if (t == tz) {
      n = vec3(0.0, 0.0, -1.0);
      alb = wallAlbedo(vec2(p.x + seed * 3.0, p.y), vWall.rgb, vWall.a, detail);
      ao = min(min(p.x - xL, xR - p.x), min(p.y, H - p.y));
    } else if (t == tx) {
      n = vec3(-sign(rd.x), 0.0, 0.0);
      alb = wallAlbedo(vec2(p.z * sign(rd.x) + seed * 5.0, p.y), vWall.rgb, vWall.a, detail);
      ao = min(D - p.z, min(p.y, H - p.y));
    } else if (rd.y < 0.0) {
      n = vec3(0.0, 1.0, 0.0);
      alb = floorAlbedo(vec2(p.x, p.z), vFloor.rgb, vFloor.a, detail);
      ao = min(D - p.z, min(p.x - xL, xR - p.x));
    } else {
      n = vec3(0.0, -1.0, 0.0);
      float beam = step(abs(fract(p.z / 0.75 + seed) - 0.5), 0.1);
      alb = vec3(0.07, 0.045, 0.028) * (1.0 - 0.45 * beam);
      ao = min(D - p.z, min(p.x - xL, xR - p.x));
    }
    ao = 0.55 + 0.45 * smoothstep(0.0, 0.45, ao);
    vec3 emis = vec3(0.0);

    // Decoração na parede do fundo (amostrada sempre; vale só onde o raio bateu no fundo)
    vec3 pb = ro + rd * tz;
    vec4 dc = sprite(vCard0.w, vec2(pb.x - vCard1.w, pb.y));
    float onBack = (t == tz) ? smoothstep(0.25, 0.4, dc.a) : 0.0;
    alb = mix(alb, dc.rgb, onBack);
    float fireLevel = vCard2.w * (0.55 + 0.45 * uNight);
    float lampOn = lampState * uNight;
    float flick = 0.9 + 0.1 * sin(uTime * 7.3 + seed * 40.0) * sin(uTime * 3.1 + seed * 11.0);
    float glowK = mix(smoothstep(0.72, 0.8, dc.a) * lampOn, 1.0, step(0.93, dc.a) * fireLevel) * onBack;
    emis += dc.rgb * glowK * 1.6 * flick;

    // Móveis: três cartões paralelos ao vidro; vale o mais próximo que for opaco
    float tBest = t;
    vec4 cards[3];
    cards[0] = vCard0;
    cards[1] = vCard1;
    cards[2] = vCard2;
    for (int i = 0; i < 3; i++) {
      vec4 cd = cards[i];
      float tc = (cd.z - ro.z) / rd.z;
      vec3 pc = ro + rd * tc;
      vec4 sc = sprite(cd.x, vec2(pc.x - cd.y, pc.y));
      float hit = step(0.25, sc.a) * step(tc, tBest);
      float cov = smoothstep(0.25, 0.4, sc.a) * hit;
      alb = mix(alb, sc.rgb, cov);
      n = mix(n, vec3(0.0, 0.0, -1.0), hit);
      ao = mix(ao, 0.85 + 0.15 * smoothstep(0.0, 0.5, pc.y), hit);
      float gk = mix(smoothstep(0.72, 0.8, sc.a) * lampOn, 1.0, step(0.93, sc.a) * fireLevel);
      emis = mix(emis, sc.rgb * gk * 1.6 * flick, hit);
      p = mix(p, pc, hit);
      tBest = mix(tBest, tc, hit);
    }

    // Porta trancada: a folha aberta gira para dentro da sala (giro lido de world.hinges)
    if (kind > 0.5) {
      float a = vD.z;
      vec2 hinge = vec2(-vC.z, uHingeZ);
      vec2 along = vec2(cos(a), -sin(a));
      vec2 nrm = vec2(sin(a), cos(a));
      float denom = dot(rd.xz, nrm);
      float tl = dot(hinge - ro.xz, nrm) / (abs(denom) < 1e-5 ? 1e-5 : denom);
      vec3 pl = ro + rd * tl;
      float sAlong = dot(pl.xz - hinge, along);
      float leafW = vC.z * 2.0;
      float spring = vC.w * 2.0 - vC.z;
      float dx = sAlong - vC.z;
      float top = spring + sqrt(max(vC.z * vC.z - dx * dx, 0.0));
      float leaf = step(0.0, tl) * step(tl, tBest) * step(0.0, sAlong) * step(sAlong, leafW) * step(pl.y, top) * step(0.0, pl.y);
      float plank = fract(sAlong / 0.14);
      float band = step(abs(pl.y - 0.45), 0.04) + step(abs(pl.y - 1.55), 0.04);
      vec3 wood = vec3(0.16, 0.09, 0.05) * (0.8 + 0.2 * hash1(floor(sAlong / 0.14) + 3.0)) * (1.0 - 0.5 * step(0.93, plank));
      wood = mix(wood, vec3(0.03, 0.03, 0.035), min(band, 1.0) * step(0.08, sAlong));
      vec3 ln = vec3(nrm.x, 0.0, nrm.y);
      ln *= -sign(dot(ln, rd));
      alb = mix(alb, wood, leaf);
      n = mix(n, ln, leaf);
      emis *= 1.0 - leaf;
      p = mix(p, pl, leaf);
      ao = mix(ao, 0.9, leaf);
      tBest = mix(tBest, tl, leaf);
    }

    // Luz: dia entrando pela janela (cai com a profundidade) + lâmpada pontual quente
    vec3 L = vLampPos.xyz - p;
    float d2 = dot(L, L) + 0.04;
    float ndl = max(dot(n, L * inversesqrt(d2)), 0.0);
    float lampE = max(lampOn, vCard2.w * 0.45 * fireLevel) * vLamp.w * uLampGain * flick;
    vec3 lampLight = vLamp.rgb * lampE * (0.3 + 0.7 * ndl) / (1.0 + d2 * 0.85);
    float depthFade = 1.0 - 0.55 * clamp(p.z / D, 0.0, 1.0);
    vec3 amb = mix(vec3(uDayAmb) * vec3(1.0, 0.97, 0.92) * depthFade, vec3(uNightAmb) * vec3(0.7, 0.8, 1.0), uNight);
    vec3 col = alb * (amb * ao + lampLight * mix(1.0, ao, 0.6)) + emis;

    // Halo da lâmpada no ar (ponto mais próximo do raio até a luz)
    vec3 v = vLampPos.xyz - ro;
    float th = clamp(dot(v, rd) / dot(rd, rd), 0.0, tBest);
    vec3 off = v - rd * th;
    col += vLamp.rgb * lampE * 0.12 * exp(-dot(off, off) * 10.0);

    vec3 sky = vec3(0.5, 0.55, 0.62);
    #ifdef USE_FOG
      sky = fogColor;
    #endif
    vec3 outdoor = mix(vec3(0.85, 0.83, 0.8), vec3(0.05, 0.06, 0.09), uNight);

    if (kind < 0.5) {
      vec2 g = vec2(ro.x, ro.y - vC.y);
      float ghw = vC.z;
      float ghh = vC.w;
      // Cortinas presas nas laterais, franzidas no meio da altura; bandô no alto se fecham muito
      float cAmt = vAccent.a;
      float gy = clamp(g.y / ghh, -1.0, 1.0);
      float edge = ghw * (1.0 - cAmt * (0.7 + 0.3 * cos(gy * 1.5)));
      float curtain = step(edge, abs(g.x)) * step(0.01, cAmt);
      curtain = max(curtain, step(0.3, cAmt) * step(ghh - 0.13, g.y));
      float folds = 0.72 + 0.28 * sin(abs(g.x) * 70.0 + seed * 30.0 + gy * 2.0);
      vec3 cloth = vAccent.rgb * folds * (amb * 1.3 + vLamp.rgb * lampE * 0.22) + vAccent.rgb * vLamp.rgb * lampOn * 0.25;
      col = mix(col, cloth, curtain);
      // Vidro: reflexo de Fresnel puxado para a cor do céu/névoa
      float cosv = abs(normalize(rd).z);
      float fres = 0.05 + 0.95 * pow(1.0 - cosv, 5.0);
      float streak = 0.85 + 0.15 * sin((g.x + g.y) * 9.0 + seed * 20.0);
      vec3 refl = sky * mix(0.8, 0.5, uNight) * streak;
      col = mix(col, refl, clamp(fres * uGlass + 0.02, 0.0, 0.85) * (1.0 - curtain * 0.6));
      // Venezianas de madeira: duas folhas que se fecham para o centro (planos no vidro)
      float shut = 1.0 - clamp(vD.z, 0.0, 1.0);
      float sw = ghw + 0.04;
      float ax = abs(g.x);
      float inner = sw * (1.0 - shut);
      float inLeaf = step(inner, ax) * step(ax, sw) * step(abs(g.y), ghh + 0.04) * step(0.001, shut);
      float lx = (ax - inner) / max(shut, 0.001);
      float plank = fract(lx / 0.11);
      float gap = smoothstep(0.88, 0.94, plank) * (1.0 - smoothstep(0.97, 1.0, plank));
      float batten = step(abs(abs(g.y) - ghh * 0.55), 0.045);
      float seam = (1.0 - step(0.012, ax)) * step(0.97, shut);
      vec3 wood = vec3(0.17, 0.095, 0.05) * (0.78 + 0.22 * hash1(floor(lx / 0.11) + seed * 13.0 + sign(g.x)));
      wood *= 1.0 + 0.18 * batten;
      vec3 shutterCol = wood * outdoor * (0.55 + 0.45 * shut) * (1.0 - gap * 0.85);
      float leakMask = max(gap * (1.0 - batten), seam);
      shutterCol += vLamp.rgb * lampOn * vLamp.w * uLampGain * 0.55 * leakMask * flick;
      col = mix(col, shutterCol, inLeaf);
    }

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }`;
}

// Brilho aditivo das janelas de prédios com interior modelado (só visto de fora; a face de trás é
// descartada, então de dentro do prédio a sala real fica limpa)
const GLOW_VERTEX = /* glsl */ `
  attribute vec2 aState;
  attribute float aSeed;
  varying vec2 vUv;
  varying float vSeed;
  varying vec2 vState;
  void main() {
    vUv = uv;
    vSeed = aSeed;
    vState = aState;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const GLOW_FRAGMENT = /* glsl */ `
  uniform float uNight;
  uniform float uTime;
  uniform float uGain;
  varying vec2 vUv;
  varying float vSeed;
  varying vec2 vState;
  void main() {
    vec2 d = abs(vUv - 0.5) * 2.0;
    float edge = 1.0 - smoothstep(0.55, 1.0, max(d.x, d.y));
    float fl = 0.88 + 0.12 * sin(uTime * (1.3 + fract(vSeed) * 2.0) + vSeed * 7.0);
    vec3 col = mix(vec3(1.0, 0.55, 0.22), vec3(1.0, 0.78, 0.45), fract(vSeed * 3.1));
    float shut = 0.3 + 0.7 * clamp(vState.x, 0.0, 1.0);
    gl_FragColor = vec4(col * edge * fl * uNight * uGain * vState.y * shut, 1.0);
  }`;

// --------------------------------------------------------------------------------------------
// Montagem dos quads
// --------------------------------------------------------------------------------------------
const CORNERS = Object.freeze([[-1, -1], [1, -1], [1, 1], [-1, 1]]);
const _col = new THREE.Color();

// Lote de quads com estado animável (abertura/giro e lâmpada) por quad
class QuadBatch {
  constructor(count, attrSizes) {
    this.count = count;
    this.position = new Float32Array(count * 12);
    this.attrs = {};
    for (const [name, size] of Object.entries(attrSizes)) this.attrs[name] = new Float32Array(count * 4 * size);
    this.sizes = attrSizes;
    this.state = new Float32Array(count * 8);
    this.cur = new Float32Array(count * 2);
    this.tgt = new Float32Array(count * 2);
    this.active = new Int32Array(count);
    this.isActive = new Uint8Array(count);
    this.activeCount = 0;
    this.index = new (count * 4 > 65535 ? Uint32Array : Uint16Array)(count * 6);
    this.stateAttr = null;
    this.mesh = null;
  }

  // Quad voltado para fora (normal = (cos r, 0, -sin r)): a face de trás é descartada
  setQuad(i, cx, cy, cz, r, hw, h0, h1) {
    const tx = Math.sin(r);
    const tz = Math.cos(r);
    for (let k = 0; k < 4; k++) {
      const [u, v] = CORNERS[k];
      const o = (i * 4 + k) * 3;
      this.position[o] = cx + tx * u * hw;
      this.position[o + 1] = cy + (v < 0 ? h0 : h1);
      this.position[o + 2] = cz + tz * u * hw;
    }
    const b = i * 4;
    this.index.set([b, b + 2, b + 1, b, b + 3, b + 2], i * 6);
  }

  // Mesmo valor nos 4 vértices do quad
  setAttr(name, i, ...values) {
    const size = this.sizes[name];
    const arr = this.attrs[name];
    for (let k = 0; k < 4; k++) for (let j = 0; j < size; j++) arr[(i * 4 + k) * size + j] = values[j];
  }

  // Valor por canto (uv)
  setCornerAttr(name, i, fn) {
    const size = this.sizes[name];
    const arr = this.attrs[name];
    for (let k = 0; k < 4; k++) {
      const v = fn(CORNERS[k]);
      for (let j = 0; j < size; j++) arr[(i * 4 + k) * size + j] = v[j];
    }
  }

  initState(i, a, b) {
    this.cur[i * 2] = this.tgt[i * 2] = a;
    this.cur[i * 2 + 1] = this.tgt[i * 2 + 1] = b;
    this.writeState(i, false);
  }

  writeState(i, upload = true) {
    const a = this.cur[i * 2];
    const b = this.cur[i * 2 + 1];
    for (let k = 0; k < 4; k++) {
      this.state[(i * 4 + k) * 2] = a;
      this.state[(i * 4 + k) * 2 + 1] = b;
    }
    if (upload && this.stateAttr) {
      this.stateAttr.addUpdateRange(i * 8, 8);
      this.stateAttr.needsUpdate = true;
    }
  }

  setTarget(i, channel, value) {
    this.tgt[i * 2 + channel] = value;
    if (!this.isActive[i]) {
      this.isActive[i] = 1;
      this.active[this.activeCount++] = i;
    }
  }

  // Aproxima o estado dos alvos a velocidade constante; remove do laço o que chegou (sem alocar)
  animate(dt, rate0, rate1) {
    let n = 0;
    for (let a = 0; a < this.activeCount; a++) {
      const i = this.active[a];
      const c0 = this.cur[i * 2];
      const c1 = this.cur[i * 2 + 1];
      const t0 = this.tgt[i * 2];
      const t1 = this.tgt[i * 2 + 1];
      const n0 = c0 < t0 ? Math.min(t0, c0 + dt * rate0) : Math.max(t0, c0 - dt * rate0);
      const n1 = c1 < t1 ? Math.min(t1, c1 + dt * rate1) : Math.max(t1, c1 - dt * rate1);
      this.cur[i * 2] = n0;
      this.cur[i * 2 + 1] = n1;
      this.writeState(i);
      if (n0 === t0 && n1 === t1) this.isActive[i] = 0;
      else this.active[n++] = i;
    }
    this.activeCount = n;
  }

  build(material, name, renderOrder) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.position, 3));
    for (const [attrName, size] of Object.entries(this.sizes)) g.setAttribute(attrName, new THREE.BufferAttribute(this.attrs[attrName], size));
    this.stateAttr = new THREE.BufferAttribute(this.state, 2);
    this.stateAttr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("aState", this.stateAttr);
    g.setIndex(new THREE.BufferAttribute(this.index, 1));
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, material);
    mesh.name = name;
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = renderOrder;
    this.mesh = mesh;
    return mesh;
  }
}

function linearColor(hex) {
  _col.set(hex);
  return [_col.r, _col.g, _col.b];
}

function pick(rng, list) {
  return list[Math.floor(rng() * list.length) % list.length];
}

function spriteId(name) {
  return name && SPRITE_INDEX.has(name) ? SPRITE_INDEX.get(name) : -1;
}

function spriteWidth(name) {
  return name && SPRITE_DEFS[name] ? SPRITE_DEFS[name][0] : 0;
}

// x de um móvel de largura w dentro de [xL, xR], sorteado
function placeX(rng, w, xL, xR) {
  const lo = xL + w * 0.5 + 0.05;
  const hi = xR - w * 0.5 - 0.05;
  return lo >= hi ? (xL + xR) * 0.5 : lo + rng() * (hi - lo);
}

// Módulo Kenney de cada janela: a instância de parede com 'window' do mesmo prédio na mesma célula
// --------------------------------------------------------------------------------------------
export class Interiors {
  constructor(city, world, scene) {
    const cfg = CONFIG.interiors;
    this.city = city;
    this.K = city.cell;
    this.elapsed = 0;
    this.specs = new Map();
    this.entries = new Map();
    const fake = city.windows.filter((w) => !w.real);
    const real = city.windows.filter((w) => w.real);
    const doors = (city.doors || []).filter((d) => !d.enterable);
    this.atlas = buildAtlas();

    // Uma lâmpada por andar de prédio decide também a sala atrás da porta trancada
    const litByBuilding = new Map();
    for (const w of city.windows) if (w.floor === 0 && w.lit) litByBuilding.set(w.b, true);

    const room = new QuadBatch(fake.length + doors.length, {
      aFrame: 4, aRoom: 4, aGlass: 4, aWall: 4, aFloor: 4, aAccent: 4, aLamp: 4, aLampPos: 4, aCard0: 4, aCard1: 4, aCard2: 4, aDecor: 4,
    });
    fake.forEach((w, i) => {
      this.fillRoom(room, i, w, KIND_WINDOW);
      room.initState(i, w.open ? 1 : 0, w.lit ? 1 : 0);
      this.specs.set(w.id, w);
      this.entries.set(w.id, { batch: room, slot: i, door: false });
    });
    this.doorSlots = new Int32Array(doors.length);
    this.doorIndex = new Map();
    this.doorWanted = new Uint8Array(doors.length);
    this.doorHinges = [];
    this.doorAngles = new Float32Array(doors.length);
    doors.forEach((d, j) => {
      const i = fake.length + j;
      this.fillRoom(room, i, d, KIND_DOOR, null);
      room.initState(i, 0, litByBuilding.get(d.b) ? 1 : 0);
      this.doorSlots[j] = i;
      this.doorHinges.push(world.hinges ? world.hinges.get(d.id) || null : null);
      this.doorAngles[j] = 0;
      this.doorIndex.set(d.id, j);
      this.doorWanted[j] = d.open ? 1 : 0;
      this.specs.set(d.id, d);
      this.entries.set(d.id, { batch: room, slot: i, door: true });
    });

    const uniforms = {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uAtlas: { value: this.atlas.texture },
      uSprites: { value: Array.from({ length: SPRITE_NAMES.length }, (_, k) => new THREE.Vector4().fromArray(this.atlas.meta, k * 4)) },
      uGrid: { value: this.atlas.grid },
      uPad: { value: this.atlas.padFrac },
      uNight: world.nightUniform,
      uTime: { value: 0 },
      uDayAmb: { value: cfg.dayAmbient },
      uNightAmb: { value: cfg.nightAmbient },
      uLampGain: { value: cfg.lampGain },
      uGlass: { value: cfg.glass },
      uHingeZ: { value: DOOR_HINGE_IN * this.K - cfg.doorInset },
      uPatternFade: { value: new THREE.Vector2(cfg.patternFade[0], cfg.patternFade[1]) },
    };
    this.uniforms = uniforms;
    const roomMat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: ROOM_VERTEX,
      fragmentShader: roomFragment(SPRITE_NAMES.length),
      fog: true,
      side: THREE.FrontSide,
    });
    roomMat.name = "InteriorMapping";
    this.room = room;
    // Depois dos opacos: a parede já está no z-buffer e recorta o quad de graça (early-z)
    if (room.count) scene.add(room.build(roomMat, "FakeInteriors", 1));

    // Janelas de prédios com interior real: só o brilho quente visto de fora, à noite
    const glow = new QuadBatch(real.length, { uv: 2, aSeed: 1 });
    real.forEach((w, i) => {
      glow.setQuad(i, w.p[0], w.p[1], w.p[2], w.r, w.w * 0.5, -w.h * 0.5, w.h * 0.5);
      glow.setCornerAttr("uv", i, ([u, v]) => [(u + 1) * 0.5, (v + 1) * 0.5]);
      glow.setAttr("aSeed", i, i * 1.37);
      glow.initState(i, w.open ? 1 : 0, w.lit ? 1 : 0);
      this.specs.set(w.id, w);
      this.entries.set(w.id, { batch: glow, slot: i, door: false });
    });
    this.glowUniforms = { uNight: world.nightUniform, uTime: uniforms.uTime, uGain: { value: cfg.realGlow } };
    const glowMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
      blending: THREE.AdditiveBlending,
      uniforms: this.glowUniforms,
      vertexShader: GLOW_VERTEX,
      fragmentShader: GLOW_FRAGMENT,
    });
    glowMat.name = "RealWindowGlow";
    this.glow = glow;
    if (glow.count) scene.add(glow.build(glowMat, "WindowGlow", 2));
    this.stats = { rooms: fake.length, doorways: doors.length, glows: real.length, sprites: SPRITE_NAMES.length };
  }

  // Preenche os atributos de uma sala (janela ou vão de porta)
  fillRoom(batch, i, spec, kind) {
    const cfg = CONFIG.interiors;
    const K = this.K;
    const style = ROOM_STYLES[spec.room] || ROOM_STYLES.casa;
    const layout = kind === KIND_DOOR ? ENTRY_LAYOUT : style;
    const nx = Math.cos(spec.r);
    const nz = -Math.sin(spec.r);
    const seedNum = Math.floor((spec.seed ?? (hashString(spec.id) % 997) / 997) * 1e6);
    const rng = mulberry32(hashString(spec.id) ^ seedNum);
    const rngB = mulberry32(hashString(`${spec.b}:${spec.floor ?? 0}`));
    const seed = (seedNum % 1000) / 1000;

    // Plano do vidro/vão dentro da parede, piso da sala e vão visível
    const floorY = kind === KIND_DOOR ? spec.p[1] : (spec.floor ?? 0) * K;
    const inset = kind === KIND_DOOR ? cfg.doorInset : cfg.windowInset;
    const cx = spec.p[0] - nx * inset;
    const cz = spec.p[2] - nz * inset;
    let gcy;
    let ghw;
    let ghh;
    if (kind === KIND_DOOR) {
      ghw = spec.w * 0.5;
      ghh = spec.h * 0.5;
      gcy = ghh;
    } else {
      // w/h/p.y já são o vão real do módulo (tools/build_city.py: WINDOW_OPENINGS)
      ghw = spec.w * 0.5;
      ghh = spec.h * 0.5;
      gcy = spec.p[1] - floorY;
    }
    const qw = ghw + cfg.cover;
    const q0 = kind === KIND_DOOR ? -0.05 : Math.max(0.05, gcy - ghh - cfg.cover);
    const q1 = Math.min(K - 0.05, gcy + ghh + cfg.cover);
    batch.setQuad(i, cx, floorY, cz, spec.r, qw, q0, q1);

    // Caixa da sala: mais larga que o vão, deslocada de lado por sorteio
    const half = cfg.roomWidth * 0.5;
    const maxShift = Math.max(0, Math.min(cfg.roomShift, half - qw - 0.1));
    const shift = (rng() * 2 - 1) * maxShift;
    const xL = -half + shift;
    const xR = half + shift;
    const H = K - cfg.ceilingDrop;
    const D = kind === KIND_DOOR ? cfg.doorDepth : spec.depth;
    const mirror = kind === KIND_WINDOW && rng() < 0.5 ? 1 : 0;
    batch.setAttr("aFrame", i, cx, floorY, cz, spec.r);
    batch.setAttr("aRoom", i, xL, xR, H, D);
    batch.setAttr("aGlass", i, gcy, ghw, ghh, kind + 2 * mirror);
    batch.setAttr("aWall", i, ...linearColor(pick(rngB, style.walls)), pick(rngB, style.papers));
    batch.setAttr("aFloor", i, ...linearColor(pick(rngB, style.floor)), style.floorPattern);
    const curtain = kind === KIND_WINDOW && rng() < style.curtainChance ? 0.15 + rng() * 0.3 : 0;
    batch.setAttr("aAccent", i, ...linearColor(pick(rng, style.curtains)), curtain);

    // Móveis: fundo, meio, frente (profundidades crescentes a partir do fundo)
    const backName = pick(rng, layout.back);
    const midName = pick(rng, layout.mid);
    const frontName = pick(rng, layout.front);
    const decorName = pick(rng, layout.decor);
    const backX = placeX(rng, spriteWidth(backName), xL, xR);
    const midX = placeX(rng, spriteWidth(midName), xL, xR);
    const frontX = placeX(rng, spriteWidth(frontName), xL, xR);
    const decorX = placeX(rng, spriteWidth(decorName), xL, xR);
    const backZ = D - 0.22 - rng() * 0.12;
    const midZ = D * (0.5 + rng() * 0.12);
    const frontZ = D * (0.3 + rng() * 0.1);
    const sway = (name) => (name === "person" ? PERSON_SWAY : 0);
    batch.setAttr("aCard0", i, spriteId(backName), backX, backZ, sway(backName));
    batch.setAttr("aCard1", i, spriteId(midName), midX, midZ, sway(midName));
    batch.setAttr("aCard2", i, spriteId(frontName), frontX, frontZ, sway(frontName));
    batch.setAttr("aDecor", i, spriteId(decorName), decorX, style.fire, 0);

    // Lâmpada: na mesa (se houver móvel no meio), no forro ou junto ao fogo do fundo
    const [lampHex, lampI, lampAt] = style.lamp;
    let lx = (xL + xR) * 0.5;
    let ly = H - 0.35;
    let lz = D * 0.5;
    if (lampAt === "table" && midName) {
      lx = midX + 0.3;
      ly = 1.05;
      lz = midZ - 0.12;
    } else if (lampAt === "hearth" && backName) {
      lx = backX;
      ly = 0.9;
      lz = backZ - 0.35;
    }
    batch.setAttr("aLamp", i, ...linearColor(lampHex), lampI * (0.85 + rng() * 0.3));
    batch.setAttr("aLampPos", i, lx, ly, lz, seed);
  }

  // ---- API pública (props.js / interação) ----------------------------------------------------
  windowById(id) {
    return this.specs.get(id) || null;
  }

  // Estado-alvo atual da janela (true = vidro/sala visível)
  isWindowOpen(id) {
    const e = this.entries.get(id);
    return e ? e.batch.tgt[e.slot * 2] > 0.5 : false;
  }

  setWindowOpen(id, open) {
    const e = this.entries.get(id);
    if (!e || e.door) return false;
    e.batch.setTarget(e.slot, 0, open ? 1 : 0);
    return true;
  }

  // Porta trancada abrindo/fechando (props.js avisa; portas de interior real são ignoradas).
  // O giro visível vem de world.hinges a cada quadro; sem dobradiça registrada, a folha virtual
  // gira sozinha até o ângulo padrão do CONFIG.
  setDoorOpen(id, open) {
    const j = this.doorIndex.get(id);
    if (j === undefined) return false;
    this.doorWanted[j] = open ? 1 : 0;
    if (!this.doorHinges[j]) this.room.setTarget(this.doorSlots[j], 0, open ? CONFIG.props.hinge.angle : 0);
    return true;
  }

  isDoorOpen(id) {
    const j = this.doorIndex.get(id);
    return j === undefined ? false : this.doorWanted[j] === 1;
  }

  setLampOn(id, on) {
    const e = this.entries.get(id);
    if (!e) return false;
    e.batch.setTarget(e.slot, 1, on ? 1 : 0);
    return true;
  }

  // Por quadro: tempo do shader, animações ativas e giro das folhas das portas trancadas
  update(dt, elapsed) {
    const cfg = CONFIG.interiors;
    this.elapsed = elapsed;
    this.uniforms.uTime.value = elapsed;
    const step = Math.max(0, Math.min(dt, 0.1));
    const r0 = 1 / cfg.openTime;
    const r1 = 1 / cfg.lampTime;
    if (this.room.activeCount) this.room.animate(step, r0, r1);
    if (this.glow.activeCount) this.glow.animate(step, r0, r1);
    for (let j = 0; j < this.doorHinges.length; j++) {
      const h = this.doorHinges[j];
      if (!h) continue;
      const a = Number.isNaN(h.current) ? 0 : h.current;
      if (a === this.doorAngles[j]) continue;
      this.doorAngles[j] = a;
      const i = this.doorSlots[j];
      this.room.cur[i * 2] = a;
      this.room.tgt[i * 2] = a;
      this.room.writeState(i);
    }
  }
}

export function buildInteriors(city, world, scene) {
  return new Interiors(city, world, scene);
}
