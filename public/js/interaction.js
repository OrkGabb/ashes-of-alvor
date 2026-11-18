import { CONFIG } from "./config.js";

// Sistema de interação: cada interativo informa distância, rótulo e prioridade. Novos tipos entram
// por register() sem tocar no laço principal (aberto para extensão).

export class InteractionSystem {
  constructor() {
    this.items = [];
    this.focused = null;
  }

  register(item) {
    this.items.push(item);
  }

  update(playerPos) {
    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (!it.enabled()) continue;
      const d = it.distance(playerPos);
      if (d > it.reach) continue;
      const score = it.priority * 100 - d;
      if (score > bestScore) {
        bestScore = score;
        best = it;
      }
    }
    this.focused = best;
    return best;
  }
}

// Registro tipo -> fábrica para os interativos do city.json (city.interactables[].kind). Tipos
// desconhecidos são ignorados: o layout pode ganhar tipos novos antes do cliente saber tratá-los.
export class InteractableRegistry {
  constructor() {
    this.factories = new Map();
  }

  define(kind, factory) {
    this.factories.set(kind, factory);
    return this;
  }

  has(kind) {
    return this.factories.has(kind);
  }

  // Cria e registra um interativo por spec conhecida; devolve quantos entraram
  build(specs, system) {
    let n = 0;
    for (const spec of specs || []) {
      const factory = this.factories.get(spec.kind);
      if (!factory) continue;
      const item = factory(spec);
      if (!item) continue;
      system.register(item);
      n++;
    }
    return n;
  }
}

export function npcInteractable(agent, onTalk) {
  const named = agent.kind === "named";
  return {
    id: `npc:${agent.id}`,
    priority: named ? 3 : 1,
    reach: CONFIG.interact.npcRadius,
    label: () => (named ? `Falar com ${agent.name}` : `Cumprimentar ${agent.name}`),
    muted: () => false,
    enabled: () => agent.root.visible,
    distance: (pos) => Math.hypot(agent.root.position.x - pos.x, agent.root.position.z - pos.z),
    interact: () => onTalk(agent),
  };
}

export function collectibleInteractable(key, spec, game, onCollect) {
  const def = game.collectibleDefs[key] || { rotulo: "Pegar" };
  return {
    id: `collect:${key}`,
    priority: 4,
    reach: spec.reach || 1.4,
    label: () => {
      const s = game.collectibleState(key);
      if (s.eligible) return def.rotulo;
      if (key === "bolinho") return "Um gato laranja encharcado... de quem será?";
      if (key.startsWith("erva")) return "Folhas vermelhas e mornas (alguém pagaria por isso?)";
      if (key === "lenha_patio") return game.temLenha ? "Você já carrega um feixe" : "Pilha de lenha do Bram";
      return def.rotulo;
    },
    muted: () => !game.collectibleState(key).eligible,
    enabled: () => game.collectibleState(key).exists,
    distance: (pos) => Math.hypot(spec.p[0] - pos.x, spec.p[2] - pos.z),
    interact: () => onCollect(key),
  };
}

export function boardInteractable(spec, onOpen) {
  return {
    id: `board:${spec.key}`,
    priority: 2,
    reach: spec.reach || 2,
    label: () => spec.label,
    muted: () => false,
    enabled: () => true,
    distance: (pos) => Math.hypot(spec.p[0] - pos.x, spec.p[2] - pos.z),
    interact: () => onOpen(spec),
  };
}
