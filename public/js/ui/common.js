import { CONFIG } from "../config.js";

export const $ = (id) => document.getElementById(id);

// Arte 2D gerada pelo agy (retratos e ícones). Se o arquivo ainda não existe, mostra uma placa
// com a inicial na cor do personagem/item — o jogo continua legível e a arte entra quando gerada.
const missing = new Set();

// Só troca a própria arte (img ou placa): quantidade, etiquetas e outros filhos do slot ficam intactos,
// inclusive quando o erro de carregamento chega depois que o slot já foi montado.
function clearArt(el) {
  for (const c of [...el.children]) if (c.tagName === "IMG" || c.classList.contains("icon-fallback")) c.remove();
}

function fallback(el, label, color) {
  clearArt(el);
  const f = document.createElement("div");
  f.className = "icon-fallback";
  f.textContent = (label || "?").trim().charAt(0).toUpperCase();
  f.style.background = `radial-gradient(circle at 35% 30%, ${color}cc, #141a26 78%)`;
  el.prepend(f);
}

function artImage(el, url, label, color) {
  if (missing.has(url)) {
    fallback(el, label, color);
    return;
  }
  clearArt(el);
  const img = new Image();
  img.alt = label || "";
  img.decoding = "async";
  img.onerror = () => {
    missing.add(url);
    fallback(el, label, color);
  };
  img.src = url;
  el.prepend(img);
}

export function portraitInto(el, npcId, npcDef) {
  artImage(el, `${CONFIG.assets.portraitDir}${npcId}.jpg`, npcDef ? npcDef.nome : npcId, (npcDef && npcDef.cor) || "#c9a86a");
}

const ITEM_COLORS = { consumivel: "#d9822b", missao: "#5bc0eb", chave: "#d8b45a", material: "#6fd1a8" };

export function iconInto(el, itemId, itemDef) {
  artImage(el, `${CONFIG.assets.iconDir}${itemId}.png`, itemDef ? itemDef.nome : itemId, ITEM_COLORS[itemDef && itemDef.tipo] || "#8a7a62");
}

// Para o <img> do retrato do diálogo (troca de src com fallback em data-URL desenhada)
export function portraitUrl(npcId) {
  return `${CONFIG.assets.portraitDir}${npcId}.jpg`;
}

export function fallbackPortraitDataUrl(name, color) {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(90, 80, 10, 128, 128, 180);
  grad.addColorStop(0, color || "#c9a86a");
  grad.addColorStop(1, "#0b1220");
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = "#fff";
  g.font = "bold 120px Cinzel, serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.shadowColor = "rgba(0,0,0,0.6)";
  g.shadowBlur = 12;
  g.fillText((name || "?").charAt(0).toUpperCase(), 128, 140);
  return c.toDataURL("image/png");
}

export function describeEffect(effect) {
  if (!effect) return "";
  const parts = [];
  if (effect.vigor) parts.push(`+${effect.vigor} vigor`);
  if (effect.calor) parts.push(`+${effect.calor} calor`);
  if (effect.buff) parts.push(`fôlego sem fim por ${effect.buff.segundos}s`);
  return parts.join(" · ");
}
