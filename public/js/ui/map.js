import { $ } from "./common.js";

// Minimapa (canto inferior direito) e mapa completo (M). O desenho base da cidade (ruas, prédios,
// muralha, árvores) é rasterizado UMA vez num canvas fora da tela; por frame só se copia um recorte
// e se desenham o jogador e os marcadores. Atualização do minimapa a 10 Hz.

const BASE_SIZE = 2048;
// Zonas sem marco que também ganham nome no mapa completo
const LABEL_ZONES = new Set(["Backyard", "ForjaPatioZ", "CasaRosaZ", "LargoNorte", "CampoCastelo", "MoinhoZ", "EstabuloZ", "TreinoZ", "PatioCastelo"]);
const WALL_TAGS = new Set(["city_wall", "castle_wall"]);

export class CityMap {
  constructor(world, game, npcs, data) {
    this.world = world;
    this.game = game;
    this.npcs = npcs;
    this.data = data;
    // Área desenhada: quadrado cobrindo city.bounds (ou city.terrain) com margem de 8 m
    const b = world.city.bounds || world.city.terrain || { minX: -69, maxX: 69, minZ: -69, maxZ: 69 };
    const half = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) * 0.5 + 8;
    const cx = (b.minX + b.maxX) * 0.5;
    const cz = (b.minZ + b.maxZ) * 0.5;
    this.minX = cx - half;
    this.maxX = cx + half;
    this.minZ = cz - half;
    this.maxZ = cz + half;
    this.scale = BASE_SIZE / (this.maxX - this.minX);
    this.base = this.drawBase();
    this.mini = $("minimap");
    this.miniCtx = this.mini.getContext("2d");
    this.full = $("map-canvas");
    this.fullCtx = this.full.getContext("2d");
    this.timer = 0;
    this.seen = new Set();
    try {
      for (const k of JSON.parse(localStorage.getItem("alvor_seen_zones") || "[]")) this.seen.add(k);
    } catch (_) {
      /* armazenamento indisponível: só não lembra entre sessões */
    }
    this.labels = world.city.zones.filter((z) => z.name && (z.marco || z.interiorOf || z.key.endsWith("_Frente") || LABEL_ZONES.has(z.key)));
  }

  px(x) {
    return (x - this.minX) * this.scale;
  }

  pz(z) {
    return (z - this.minZ) * this.scale;
  }

  drawBase() {
    const c = document.createElement("canvas");
    c.width = c.height = BASE_SIZE;
    const g = c.getContext("2d");
    g.fillStyle = "#1d2b1c";
    g.fillRect(0, 0, BASE_SIZE, BASE_SIZE);
    const city = this.world.city;
    // Grama dentro da muralha um pouco mais clara
    const t = city.terrain || { minX: -69, maxX: 69, minZ: -69, maxZ: 69 };
    g.fillStyle = "#2a3a24";
    g.fillRect(this.px(t.minX), this.pz(t.minZ), (t.maxX - t.minX) * this.scale, (t.maxZ - t.minZ) * this.scale);
    // Trilhas de terra, água e ruas
    const ground = city.ground || {};
    if (ground.dirt) {
      g.fillStyle = "#6e583f";
      for (const r of ground.dirt) g.fillRect(this.px(r.minX), this.pz(r.minZ), (r.maxX - r.minX) * this.scale, (r.maxZ - r.minZ) * this.scale);
    }
    if (ground.water) {
      g.fillStyle = "#2f6d92";
      for (const r of ground.water) g.fillRect(this.px(r.minX), this.pz(r.minZ), (r.maxX - r.minX) * this.scale, (r.maxZ - r.minZ) * this.scale);
    }
    if (ground.cobble) {
      g.fillStyle = "#77736c";
      for (const r of ground.cobble) g.fillRect(this.px(r.minX), this.pz(r.minZ), (r.maxX - r.minX) * this.scale, (r.maxZ - r.minZ) * this.scale);
    }
    // Árvores
    g.fillStyle = "#3f6a35";
    for (const inst of city.instances) {
      if (inst.tag === "tree" || inst.tag === "forest") {
        g.beginPath();
        g.arc(this.px(inst.p[0]), this.pz(inst.p[2]), 1.6 * this.scale, 0, Math.PI * 2);
        g.fill();
      }
    }
    // Prédios (projeção dos telhados)
    for (const r of city.roofs) {
      const w = (r.maxX - r.minX) * this.scale;
      const h = (r.maxZ - r.minZ) * this.scale;
      g.fillStyle = "#b9895a";
      g.fillRect(this.px(r.minX), this.pz(r.minZ), w, h);
      g.strokeStyle = "rgba(40, 24, 12, 0.85)";
      g.lineWidth = 2;
      g.strokeRect(this.px(r.minX), this.pz(r.minZ), w, h);
    }
    // Muralhas: cada módulo como retângulo girado (comprimento = 4 unidades do KayKit x escala)
    g.fillStyle = "#a9a6a0";
    for (const inst of city.instances) {
      if (!WALL_TAGS.has(inst.tag)) continue;
      const sc = Array.isArray(inst.s) ? inst.s : [inst.s, inst.s, inst.s];
      g.save();
      g.translate(this.px(inst.p[0]), this.pz(inst.p[2]));
      g.rotate(-(inst.r || 0));
      g.fillRect(-2 * sc[0] * this.scale, -0.5 * sc[2] * this.scale - 1, 4 * sc[0] * this.scale, sc[2] * this.scale + 2);
      g.restore();
    }
    // Cristal
    g.fillStyle = "#6fe0ff";
    g.beginPath();
    g.arc(this.px(0), this.pz(0), 1.3 * this.scale, 0, Math.PI * 2);
    g.fill();
    // Monólito(s) e fogueiras de acampamento
    for (const a of Object.values(city.anchors || {})) {
      if (!a || !a.p) continue;
      const ax = this.px(a.p[0]);
      const az = this.pz(a.p[2]);
      if (a.monolith) {
        const r = 1.6 * this.scale;
        g.fillStyle = "#4ecdc4";
        g.strokeStyle = "rgba(10, 22, 30, 0.9)";
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(ax, az - r);
        g.lineTo(ax + r, az);
        g.lineTo(ax, az + r);
        g.lineTo(ax - r, az);
        g.closePath();
        g.fill();
        g.stroke();
      }
      if (a.fire === "campfire") {
        g.fillStyle = "#ff944d";
        g.beginPath();
        g.arc(ax, az, 1.0 * this.scale, 0, Math.PI * 2);
        g.fill();
      }
    }
    return c;
  }

  markSeen(zone) {
    if (!zone || !zone.name || this.seen.has(zone.key)) return;
    this.seen.add(zone.key);
    try {
      localStorage.setItem("alvor_seen_zones", JSON.stringify([...this.seen]));
    } catch (_) {
      /* sem armazenamento */
    }
  }

  questMarkers() {
    const out = [];
    for (const a of this.npcs.agents) {
      if (a.kind !== "named") continue;
      const offer = this.game.offersFor(a.id).length > 0;
      const turn = this.game.turnInsFor(a.id).length > 0;
      out.push({ a, offer, turn });
    }
    return out;
  }

  drawMarkers(g, toX, toZ, s, full) {
    for (const { a, offer, turn } of this.questMarkers()) {
      const x = toX(a.root.position.x);
      const y = toZ(a.root.position.z);
      g.fillStyle = a.def.cor || "#ffd28a";
      g.beginPath();
      g.arc(x, y, full ? 8 : 5, 0, Math.PI * 2);
      g.fill();
      if (offer || turn) {
        g.fillStyle = turn ? "#8fdc9a" : "#ffd24a";
        g.font = `bold ${full ? 30 : 16}px Inter, sans-serif`;
        g.textAlign = "center";
        g.fillText(turn ? "?" : "!", x, y - (full ? 14 : 8));
      }
      if (full) {
        g.fillStyle = "#f1e6d0";
        g.font = "18px Inter, sans-serif";
        g.textAlign = "center";
        g.fillText(a.name, x, y + 24);
      }
    }
    void s;
  }

  drawPlayer(g, x, y, yaw, size) {
    g.save();
    g.translate(x, y);
    g.rotate(-yaw);
    g.fillStyle = "#ffffff";
    g.strokeStyle = "#0b1220";
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(0, -size);
    g.lineTo(size * 0.7, size * 0.8);
    g.lineTo(0, size * 0.4);
    g.lineTo(-size * 0.7, size * 0.8);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
  }

  updateMini(dt, playerPos, yaw) {
    this.timer += dt;
    if (this.timer < 0.1) return;
    this.timer = 0;
    const g = this.miniCtx;
    const W = this.mini.width;
    const range = 34;
    const k = W / (range * 2);
    g.fillStyle = "#1d2b1c";
    g.fillRect(0, 0, W, W);
    const sx = this.px(playerPos.x - range);
    const sz = this.pz(playerPos.z - range);
    g.drawImage(this.base, sx, sz, range * 2 * this.scale, range * 2 * this.scale, 0, 0, W, W);
    const toX = (x) => (x - playerPos.x + range) * k;
    const toZ = (z) => (z - playerPos.z + range) * k;
    this.drawMarkers(g, toX, toZ, k, false);
    this.drawPlayer(g, W / 2, W / 2, yaw, 13);
  }

  renderFull(playerPos, yaw) {
    const g = this.fullCtx;
    const W = this.full.width;
    g.drawImage(this.base, 0, 0, W, W);
    const s = W / BASE_SIZE;
    const toX = (x) => this.px(x) * s;
    const toZ = (z) => this.pz(z) * s;
    const known = this.game.qty("mapa_luna") > 0;
    g.textAlign = "center";
    for (const z of this.labels) {
      const visible = known || this.seen.has(z.key) || (z.marco && this.game.marcos.has(z.marco));
      const cx = toX((z.minX + z.maxX) / 2);
      const cy = toZ((z.minZ + z.maxZ) / 2);
      g.font = z.marco ? "bold 26px Cinzel, serif" : "20px Cinzel, serif";
      g.fillStyle = z.marco ? "#9fe0ff" : "#f5d7a1";
      g.strokeStyle = "rgba(0,0,0,0.85)";
      g.lineWidth = 5;
      const text = visible ? z.name : "???";
      g.strokeText(text, cx, cy);
      g.fillText(text, cx, cy);
    }
    this.drawMarkers(g, toX, toZ, s, true);
    this.drawPlayer(g, toX(playerPos.x), toZ(playerPos.z), yaw, 20);
  }
}
