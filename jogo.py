#!/usr/bin/env python3
"""
Estado de jogo autoritativo de Cinzas de Alvor: carteira, inventário, missões em etapas, coletáveis,
marcos visitados, desbloqueios, confiança por NPC e status do corpo (vigor/calor).

O narrador (LLM) descreve o mundo, mas NÃO decide o que o jogador carrega, quanto cobre tem nem se
uma etapa foi cumprida: as transições acontecem aqui, de forma determinística, antes da chamada ao
modelo, e o resultado entra no prompt como fato de jogo. Conteúdo (itens, preços, missões, lojas) vem
de public/data/*.json — a mesma fonte que o navegador lê. Tudo persiste em relacao.json, chave "jogo".

Save v1 (só a missão da lenha) é migrado para v2 sem perder progresso nem confiança. Um save v2 anterior ao
combate (sem "equipado") recebe o equipamento inicial UMA vez; depois disso "equipado" existe e nada é dado de novo.

Combate: o cliente simula a luta; o servidor decide recompensa (cobre e drops sorteados aqui, a partir de
public/data/enemies.json), conta abates, avança contratos de caça e aplica a derrota.
"""
from __future__ import annotations

import json
import random
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import play

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "public" / "data"
VERSAO = 2

MISSAO_LENHA = "lenha_bram"
ACAO_RECOLHER = "recolher_lenha"
ACAO_ENTREGAR = "entregar_lenha"
ACAO_COLETAR = "coletar"
ACAO_ACEITAR = "aceitar"
ACAO_CONCLUIR = "concluir"
ACAO_COMPRAR = "comprar"
ACAO_USAR = "usar"
ACAO_VISITAR = "visitar"
ACAO_SINCRONIZAR = "sincronizar_status"
ACAO_EQUIPAR = "equipar"
ACAO_ABATER = "abater"
ACAO_DERROTA = "derrota"
MUNDO_INICIAL = {"hora": 9.0, "dia": 1, "chuva": 0.0, "alvo": 0.0}
TEXTO_ACAO_ENTREGA = "[Entrega o feixe de lenha cortada sobre o balcão]"

CONFIANCA_INICIAL = 0.15
STATUS_BRAM_PADRAO = "atento atrás do balcão, avaliando se o recém-chegado tem cobre ou conversa honesta"

# Combate
TIPOS_PROTEGIDOS = frozenset({"missao", "chave", "equipamento"})  # derrota nunca tira; monstro nunca derruba missão/chave
_RE_SPAWN_ID = re.compile(r"^[a-z0-9][a-z0-9_\-]{0,63}$")
FRACAO_COOLDOWN_SPAWN = 0.5        # o mesmo spawn só rende de novo após 50% do respawn dele
MAX_SPAWNS_GUARDADOS = 256         # ids de spawn lembrados para o anti-spam (os mais antigos saem)
FRACAO_RESTAURADA_DERROTA = 0.5    # vida, mana e vigor voltam a 50% do máximo
PENALIDADE_COBRE_FRACAO = 0.10     # derrota custa 10% do cobre...
PENALIDADE_COBRE_MAX = 20          # ...até 20 cobres
MARCO_ACAMPAMENTO = "Acampamento"
RESPAWN_CIDADE = "cidade"
RESPAWN_ACAMPAMENTO = "acampamento"

# Palavras de título que não identificam missão nenhuma (roteamento de modelo)
_PALAVRAS_VAZIAS = frozenset({"para", "contrato", "caca", "rank", "cade", "como", "pelo", "pela", "com", "dos", "das"})

_RE_ENTREGA_DIGITADA = re.compile(r"\b(entrego|deixo|coloco|ponho|largo|apoio|solto)\b[^.!?]*\b(lenha|feixe)\b")


def carregar_dados(data_dir: Path = DATA_DIR) -> dict[str, Any]:
    return {
        "itens": json.loads((data_dir / "items.json").read_text(encoding="utf-8")),
        "missoes": json.loads((data_dir / "quests.json").read_text(encoding="utf-8")),
        "npcs": json.loads((data_dir / "npcs.json").read_text(encoding="utf-8")),
        "inimigos": json.loads((data_dir / "enemies.json").read_text(encoding="utf-8")),
    }


@dataclass
class ResultadoAcao:
    ok: bool
    evento: str
    mensagem: str
    contexto_narrador: str = ""
    efeito: dict[str, Any] = field(default_factory=dict)
    itens_ganhos: dict[str, int] = field(default_factory=dict)
    # Campos extras da resposta HTTP (ex.: cobre ganho, respawn); nunca sobrescrevem os campos de sempre
    extra: dict[str, Any] = field(default_factory=dict)


def eh_entrega_digitada(texto: str) -> bool:
    """Reconhece a entrega da lenha quando o jogador a escreve em vez de usar o botão de ação."""
    low = play.normalizar(texto)
    return play.normalizar(TEXTO_ACAO_ENTREGA) in low or bool(_RE_ENTREGA_DIGITADA.search(low))


class EstadoJogo:
    def __init__(self, relacao: play.Relacao, memoria_txt: str = "", dados: dict[str, Any] | None = None,
                 rng: random.Random | None = None, relogio: Callable[[], float] = time.monotonic) -> None:
        self.relacao = relacao
        self.dados = dados or carregar_dados()
        self.rng = rng or random.Random()
        self.relogio = relogio
        # spawn id -> instante do último abate que rendeu recompensa (anti-spam; só em memória)
        self._spawns_abatidos: dict[str, float] = {}
        self.itens_def: dict[str, Any] = self.dados["itens"]["itens"]
        self.status_def: dict[str, Any] = self.dados["itens"]["status"]
        self.missoes_def: dict[str, Any] = self.dados["missoes"]["missoes"]
        self.coletaveis_def: dict[str, Any] = self.dados["missoes"]["coletaveis"]
        self.npcs_def: dict[str, Any] = self.dados["npcs"]["npcs"]
        self.inimigos_def: dict[str, Any] = (self.dados.get("inimigos") or {}).get("inimigos", {})
        self._garantir_estrutura(memoria_txt)

    # -- estrutura, migração ------------------------------------------------------------------
    @property
    def d(self) -> dict[str, Any]:
        return self.relacao.d["jogo"]

    def kit_inicial(self) -> tuple[dict[str, int], dict[str, str]]:
        """Inventário e equipamento de partida (quests.json: inventario_inicial / equipado_inicial)."""
        itens = {str(k): int(v) for k, v in (self.dados["missoes"].get("inventario_inicial") or {}).items() if k in self.itens_def}
        equipado = {str(k): str(v) for k, v in (self.dados["missoes"].get("equipado_inicial") or {}).items() if v in self.itens_def}
        return itens, equipado

    def estrutura_inicial(self) -> dict[str, Any]:
        itens, equipado = self.kit_inicial()
        d: dict[str, Any] = {
            "versao": VERSAO,
            "cobre": int(self.dados["missoes"].get("cobre_inicial", 0)),
            "inventario": dict(itens),
            "equipado": dict(equipado),
            "abates": {},
            "derrotas": 0,
            "missoes": {},
            "coletados": [],
            "marcos": [],
            "desbloqueios": {"ensopado": False},
            "confianca_npc": {"bram": CONFIANCA_INICIAL},
            "status": {k: float(v["inicial"]) for k, v in self.status_def.items()},
            # Relógio e clima do mundo: o cliente avança, o servidor guarda (senão toda carga voltava às 18h30 com chuva)
            "mundo": dict(MUNDO_INICIAL),
        }
        for qid, q in self.missoes_def.items():
            if q.get("auto_aceitar"):
                d["missoes"][qid] = {"estado": "ativa", "etapa": 0}
        return d

    def _migrar_v1(self, antigo: dict[str, Any] | None, memoria_txt: str) -> dict[str, Any]:
        """v1: {inventario:{tem_lenha}, missoes:{lenha_bram: pendente|coletada|concluida}, desbloqueios, confianca_npc:{Bram}}."""
        novo = self.estrutura_inicial()
        antigo = antigo if isinstance(antigo, dict) else {}
        etapa = (antigo.get("missoes") or {}).get(MISSAO_LENHA)
        if etapa not in ("pendente", "coletada", "concluida"):
            # Saves anteriores ao estado de jogo registravam a entrega só como fato narrativo
            lembrancas = " ".join(str(x) for x in (self.relacao.d.get("lembrancas") or []))
            texto = play.normalizar(f"{memoria_txt} {lembrancas}")
            etapa = "concluida" if ("entregou a lenha" in texto or "entregou a bram um feixe" in texto) else "pendente"
        if etapa == "coletada":
            novo["missoes"][MISSAO_LENHA] = {"estado": "ativa", "etapa": 1}
            novo["coletados"].append("lenha_patio")
            if (antigo.get("inventario") or {}).get("tem_lenha", True):
                novo["inventario"]["feixe_lenha"] = 1
        elif etapa == "concluida":
            novo["missoes"][MISSAO_LENHA] = {"estado": "concluida", "etapa": len(self.missoes_def[MISSAO_LENHA]["etapas"])}
            novo["coletados"].append("lenha_patio")
            novo["desbloqueios"]["ensopado"] = True
            # A recompensa em cobre não existia em v1: credita agora (o ensopado já foi comido em cena)
            novo["cobre"] += int(self.missoes_def[MISSAO_LENHA]["etapas"][-1].get("ao_concluir", {}).get("cobre", 0))
        for nome, valor in (antigo.get("confianca_npc") or {}).items():
            novo["confianca_npc"][str(nome).strip().lower()] = round(play.num(valor, 0.0, 1.0, CONFIANCA_INICIAL), 3)
        for k, v in (antigo.get("desbloqueios") or {}).items():
            novo["desbloqueios"][k] = bool(v) or novo["desbloqueios"].get(k, False)
        npcs = dict(self.relacao.d.get("npcs") or {})
        if etapa != "concluida" and "lenha entregue" in play.normalizar(str(npcs.get("Bram") or "")):
            npcs["Bram"] = STATUS_BRAM_PADRAO
            self.relacao.d["npcs"] = npcs
        return novo

    @staticmethod
    def _precisa_kit(atual: dict[str, Any]) -> bool:
        """Save v2 anterior ao combate não tem "equipado"; depois da primeira carga tem, e o kit não volta."""
        return not isinstance(atual.get("equipado"), dict)

    def _dar_kit_inicial(self, atual: dict[str, Any]) -> None:
        """Armas iniciais na bolsa (sem tirar nada do que já existe) e a espada em mãos."""
        itens, equipado = self.kit_inicial()
        inv = atual.get("inventario") if isinstance(atual.get("inventario"), dict) else {}
        for k, v in itens.items():
            inv[k] = max(int(inv.get(k, 0)), v)
        atual["inventario"] = inv
        atual["equipado"] = dict(equipado)

    def _garantir_estrutura(self, memoria_txt: str) -> None:
        atual = self.relacao.d.get("jogo")
        if not (isinstance(atual, dict) and atual.get("versao") == VERSAO):
            self.relacao.d["jogo"] = self._migrar_v1(atual, memoria_txt)
        else:
            if self._precisa_kit(atual):
                self._dar_kit_inicial(atual)
            base = self.estrutura_inicial()
            for chave, valor in base.items():
                if chave not in atual or type(atual[chave]) is not type(valor):
                    atual[chave] = valor
            for k, v in base["status"].items():
                atual["status"].setdefault(k, v)
            if "vida" in self.status_def and float(atual["status"].get("vida", 1)) <= 0:
                # Nunca carregar desmaiado (a página fechou antes da derrota ser registrada)
                atual["status"]["vida"] = round(float(self.status_def["vida"]["max"]) * FRACAO_RESTAURADA_DERROTA, 1)
            for qid, q in self.missoes_def.items():
                if q.get("auto_aceitar"):
                    atual["missoes"].setdefault(qid, {"estado": "ativa", "etapa": 0})
        self._avancar_automatico()
        self.sincronizar_tarefa()
        self.relacao.salvar()

    # -- leitura ----------------------------------------------------------------------------------
    def qtd(self, item: str) -> int:
        return int(self.d["inventario"].get(item, 0))

    @property
    def cobre(self) -> int:
        return int(self.d["cobre"])

    def missao(self, qid: str) -> dict[str, Any] | None:
        return self.d["missoes"].get(qid)

    def etapa_atual(self, qid: str) -> dict[str, Any] | None:
        m = self.missao(qid)
        if not m or m["estado"] != "ativa":
            return None
        etapas = self.missoes_def[qid]["etapas"]
        return etapas[m["etapa"]] if m["etapa"] < len(etapas) else None

    def confianca(self, npc: str) -> float:
        return float(self.d["confianca_npc"].get(npc, CONFIANCA_INICIAL))

    # Compatibilidade com a missão original (HUD antigo e testes da lenha)
    @property
    def etapa_lenha(self) -> str:
        m = self.missao(MISSAO_LENHA) or {"estado": "ativa", "etapa": 0}
        if m["estado"] == "concluida":
            return "concluida"
        return "coletada" if m["etapa"] >= 1 else "pendente"

    @property
    def tem_lenha(self) -> bool:
        return self.qtd("feixe_lenha") > 0

    @property
    def ensopado_liberado(self) -> bool:
        return bool(self.d["desbloqueios"].get("ensopado"))

    @property
    def confianca_bram(self) -> float:
        return self.confianca("bram")

    def missoes_disponiveis(self, npc: str) -> list[str]:
        out = []
        for qid, q in self.missoes_def.items():
            if q.get("doador") != npc or qid in self.d["missoes"]:
                continue
            if q.get("requer_item") and self.qtd(q["requer_item"]) <= 0:
                continue
            req = q.get("requer_missao")
            if req and (self.missao(req) or {}).get("estado") != "concluida":
                continue
            out.append(qid)
        return out

    def etapas_com_npc(self, npc: str) -> list[str]:
        """Missões ativas cuja etapa atual se resolve falando/entregando a este NPC."""
        out = []
        for qid in self.d["missoes"]:
            et = self.etapa_atual(qid)
            if et and et["objetivo"].get("npc") == npc and et["objetivo"]["tipo"] in ("entregar", "pagar", "falar"):
                out.append(qid)
        return out

    def progresso_abate(self, qid: str) -> tuple[int, int] | None:
        """(feitos, pedidos) da etapa atual se ela for de abater; abates contam só depois de aceitar."""
        et = self.etapa_atual(qid)
        if not et or et["objetivo"]["tipo"] != "abater":
            return None
        pedidos = int(et["objetivo"].get("qtd", 1))
        feitos = int((self.missao(qid) or {}).get("progresso", 0))
        return min(feitos, pedidos), pedidos

    def texto_etapa(self, qid: str) -> str:
        """Texto da etapa atual, com o contador "(2/5)" nas etapas de caça."""
        et = self.etapa_atual(qid)
        if not et:
            return ""
        prog = self.progresso_abate(qid)
        return f"{et['texto']} ({prog[0]}/{prog[1]})" if prog else str(et["texto"])

    def tarefa(self) -> str:
        for qid, m in self.d["missoes"].items():
            et = self.etapa_atual(qid)
            if et:
                return self.texto_etapa(qid)
        lenha = self.missoes_def[MISSAO_LENHA]
        if self.etapa_lenha == "concluida":
            return lenha.get("texto_concluida", "Explore a capital")
        return "Explore a capital e converse com os moradores"

    def publico(self) -> dict[str, Any]:
        missoes = {}
        for qid, m in self.d["missoes"].items():
            q = self.missoes_def.get(qid)
            if not q:
                continue
            et = self.etapa_atual(qid)
            missoes[qid] = {
                "estado": m["estado"],
                "etapa": m["etapa"],
                "titulo": q["titulo"],
                "texto": self.texto_etapa(qid) if et else q.get("texto_concluida", "Concluída"),
                "objetivo": et["objetivo"] if et else None,
            }
            prog = self.progresso_abate(qid)
            if prog:
                missoes[qid]["progresso"] = {"atual": prog[0], "total": prog[1]}
        disponiveis = {npc: self.missoes_disponiveis(npc) for npc in self.npcs_def}
        return {
            "cobre": self.cobre,
            "itens": {k: v for k, v in self.d["inventario"].items() if v > 0},
            "missoes": missoes,
            "missoes_disponiveis": {k: v for k, v in disponiveis.items() if v},
            "coletados": list(self.d["coletados"]),
            "marcos": list(self.d["marcos"]),
            "desbloqueios": dict(self.d["desbloqueios"]),
            "confianca_npc": dict(self.d["confianca_npc"]),
            "status": dict(self.d["status"]),
            "mundo": dict(self.d["mundo"]),
            "equipado": dict(self.d["equipado"]),
            "abates": dict(self.d["abates"]),
            # Compatibilidade (HUD e testes da missão da lenha)
            "inventario": {"tem_lenha": self.tem_lenha},
            "missao_lenha": self.etapa_lenha,
            "ensopado_desbloqueado": self.ensopado_liberado,
            "confianca_bram": round(self.confianca_bram, 3),
            "tarefa": self.tarefa(),
        }

    def pistas_roteamento(self) -> tuple[tuple[str, ...], ...]:
        """Termos que identificam cada missão ativa (título, itens do objetivo/aceite, alvo de caça), normalizados,
        para o roteador de modelo (play.escolher_modelo) saber quando o jogador cruza pistas de missões diferentes."""
        out = []
        for qid in self.d["missoes"]:
            et = self.etapa_atual(qid)
            q = self.missoes_def.get(qid)
            if not et or not q:
                continue
            nomes = [q["titulo"]]
            itens = [et["objetivo"].get("item")] + list(((q.get("ao_aceitar") or {}).get("dar") or {}))
            nomes += [self.nome_item(i) for i in itens if i]
            alvo = et["objetivo"].get("alvo")
            if alvo:
                nomes.append(str(self.inimigos_def.get(alvo, {}).get("nome", alvo)))
            termos = set()
            for palavra in play.normalizar(" ".join(nomes)).split():
                if len(palavra) >= 4 and palavra not in _PALAVRAS_VAZIAS:
                    termos.add(palavra[:-1] if palavra.endswith("s") and len(palavra) > 4 else palavra)
            if termos:
                out.append(tuple(sorted(termos)))
        return tuple(out)

    def bloco_narrador(self, evento: str = "", npc: str = "") -> str:
        """Fatos de jogo autoritativos para o prompt (o narrador não pode contradizê-los)."""
        itens = ", ".join(f"{self.itens_def[k]['nome']} x{v}" for k, v in self.d["inventario"].items() if v > 0 and k in self.itens_def)
        linhas = [
            "# Estado de Jogo (autoritativo — NÃO contradiga, NÃO invente itens nem dinheiro)",
            f"- Bolsa do jogador: {self.cobre} cobres; itens: {itens or 'nenhum'}.",
            f"- Missão 'Lenha para o Bram': {self.etapa_lenha}; ensopado da casa {'liberado' if self.ensopado_liberado else 'ainda não liberado'}.",
        ]
        ativas = [f"{self.missoes_def[q]['titulo']} ({self.texto_etapa(q)})" for q in self.d["missoes"] if self.etapa_atual(q)]
        if ativas:
            linhas.append(f"- Missões em andamento: {'; '.join(ativas)}.")
        feitas = [self.missoes_def[q]["titulo"] for q, m in self.d["missoes"].items() if m["estado"] == "concluida" and q in self.missoes_def]
        if feitas:
            linhas.append(f"- Missões já concluídas: {', '.join(feitas)}.")
        if npc and npc in self.npcs_def:
            linhas.append(f"- Confiança de {self.npcs_def[npc]['nome']} no jogador: {round(self.confianca(npc) * 100)}%.")
        if self.qtd("cartao_guilda") > 0:
            linhas.append("- O jogador é aventureiro registrado na Guilda (Rank F).")
        linhas.extend(self._linhas_combate())
        if evento:
            linhas.append(f"- EVENTO DESTE TURNO: {evento}")
        return "\n".join(linhas)

    # -- transições ---------------------------------------------------------------------------------
    def sincronizar_tarefa(self) -> None:
        self.relacao.d["tarefa"] = self.tarefa()

    def _dar(self, itens: dict[str, int]) -> None:
        for k, v in itens.items():
            limite = int(self.itens_def.get(k, {}).get("empilha", 99))
            self.d["inventario"][k] = min(limite, self.qtd(k) + int(v))

    def _tirar(self, item: str, qtd: int) -> None:
        resto = self.qtd(item) - qtd
        if resto > 0:
            self.d["inventario"][item] = resto
        else:
            self.d["inventario"].pop(item, None)

    def _aplicar_conclusao(self, qid: str, etapa: dict[str, Any]) -> tuple[str, dict[str, int]]:
        ac = etapa.get("ao_concluir") or {}
        dados = dict(ac.get("dar") or {})
        self._dar(dados)
        self.d["cobre"] = self.cobre + int(ac.get("cobre", 0))
        for npc, delta in (ac.get("confianca") or {}).items():
            self.d["confianca_npc"][npc] = round(min(1.0, self.confianca(npc) + float(delta)), 3)
        if ac.get("desbloqueio"):
            self.d["desbloqueios"][ac["desbloqueio"]] = True
        if ac.get("status_npc"):
            npcs = dict(self.relacao.d.get("npcs") or {})
            for npc, status in ac["status_npc"].items():
                npcs[self.npcs_def.get(npc, {}).get("nome", npc.capitalize())] = status
            self.relacao.d["npcs"] = npcs
        rel = ac.get("relacao_luna") or {}
        for k in ("proximidade", "confianca", "tensao"):
            if k in rel:
                atual = play.num(self.relacao.d.get(k, 0.0), 0.0, 1.0)
                passo = play.num(rel[k], -play.PASSO_MAX, play.PASSO_MAX)
                self.relacao.d[k] = round(play.num(atual + passo, 0.0, 1.0), 3)
        if ac.get("lembranca"):
            self.relacao.adicionar_lembranca(ac["lembranca"])
        m = self.d["missoes"][qid]
        m["etapa"] += 1
        m.pop("progresso", None)  # contador de abates é por etapa
        if m["etapa"] >= len(self.missoes_def[qid]["etapas"]):
            m["estado"] = "concluida"
        if ac.get("cobre"):
            dados["cobre"] = int(ac["cobre"])
        return str(ac.get("narrar") or ""), dados

    def _coleta_cumprida(self, qid: str, et: dict[str, Any]) -> bool:
        """Etapa de coletar: o item na bolsa basta, EXCETO quando a etapa tem coletáveis próprios no mundo
        (coletaveis com missao/etapa apontando para ela). Aí só conta o que veio desses pontos: um drop de
        monstro do mesmo item (ex.: minerio_alvor do slime) não pode pular "recuperar a carga da carroça"."""
        obj = et["objetivo"]
        pedidos = int(obj.get("qtd", 1))
        if self.qtd(obj["item"]) < pedidos:
            return False
        vinculados = [(k, c) for k, c in self.coletaveis_def.items() if c.get("missao") == qid and c.get("etapa") == et.get("id")]
        if not vinculados:
            return True
        return sum(int(c.get("qtd", 1)) for k, c in vinculados if k in self.d["coletados"]) >= pedidos

    def _avancar_automatico(self) -> list[str]:
        """Etapas de coletar/visitar/abater se cumprem sozinhas assim que o requisito existe."""
        avancadas = []
        mudou = True
        while mudou:
            mudou = False
            for qid in list(self.d["missoes"]):
                et = self.etapa_atual(qid)
                if not et:
                    continue
                obj = et["objetivo"]
                prog = self.progresso_abate(qid)
                pronto = (obj["tipo"] == "coletar" and self._coleta_cumprida(qid, et)) or (
                    obj["tipo"] == "visitar" and all(m in self.d["marcos"] for m in obj["marcos"])) or (
                    prog is not None and prog[0] >= prog[1])
                if pronto:
                    self._aplicar_conclusao(qid, et)
                    avancadas.append(qid)
                    mudou = True
        return avancadas

    def _concluir_salvar(self, res: ResultadoAcao) -> ResultadoAcao:
        if res.ok:
            self._avancar_automatico()
            self.sincronizar_tarefa()
            self.relacao.salvar()
        return res

    def coletar(self, alvo: str) -> ResultadoAcao:
        c = self.coletaveis_def.get(alvo)
        if not c:
            return ResultadoAcao(False, "coletavel_desconhecido", "Não há nada aqui para pegar.")
        if alvo == "lenha_patio":
            if self.tem_lenha:
                return ResultadoAcao(False, "ja_carrega_lenha", "Você já carrega um feixe de lenha.")
            if self.etapa_lenha == "concluida":
                return ResultadoAcao(False, "missao_concluida", "Bram já recebeu a lenha de hoje.")
        if alvo in self.d["coletados"]:
            return ResultadoAcao(False, "ja_coletado", "Já não há mais nada aqui.")
        qid = c.get("missao")
        if qid:
            et = self.etapa_atual(qid)
            if not et or et["id"] != c.get("etapa"):
                if alvo == "lenha_patio" and self.tem_lenha:
                    return ResultadoAcao(False, "ja_carrega_lenha", "Você já carrega um feixe de lenha.")
                if (self.missao(qid) or {}).get("estado") == "concluida":
                    return ResultadoAcao(False, "missao_concluida", "Bram já recebeu a lenha de hoje." if alvo == "lenha_patio" else "Você já resolveu isso.")
                return ResultadoAcao(False, "sem_motivo", "Melhor deixar isso aí por enquanto.")
        self.d["coletados"].append(alvo)
        self._dar({c["item"]: int(c.get("qtd", 1))})
        nome = self.itens_def[c["item"]]["nome"]
        evento = "lenha_recolhida" if alvo == "lenha_patio" else "item_coletado"
        msg = "Feixe de lenha recolhido. Leve-o até Bram, no balcão." if alvo == "lenha_patio" else f"{nome} adicionado à bolsa."
        return self._concluir_salvar(ResultadoAcao(True, evento, msg, itens_ganhos={c["item"]: int(c.get("qtd", 1))}))

    def recolher_lenha(self) -> ResultadoAcao:
        return self.coletar("lenha_patio")

    def aceitar(self, qid: str, npc: str = "") -> ResultadoAcao:
        q = self.missoes_def.get(qid)
        if not q:
            return ResultadoAcao(False, "missao_desconhecida", "Missão desconhecida.")
        if npc and q.get("doador") != npc:
            return ResultadoAcao(False, "doador_errado", "Essa pessoa não oferece esse trabalho.")
        if qid not in self.missoes_disponiveis(q["doador"]):
            return ResultadoAcao(False, "indisponivel", "Essa missão não está disponível agora.")
        self.d["missoes"][qid] = {"estado": "ativa", "etapa": 0}
        dados = dict((q.get("ao_aceitar") or {}).get("dar") or {})
        self._dar(dados)
        nome = self.npcs_def[q["doador"]]["nome"]
        return self._concluir_salvar(ResultadoAcao(True, "missao_aceita", f"Missão aceita: {q['titulo']}", (
            f"O jogador aceita a missão '{q['titulo']}' de {nome}: {q['resumo']} Narre {nome} explicando o pedido com o próprio jeito."),
            itens_ganhos=dados))

    def concluir(self, qid: str, npc: str) -> ResultadoAcao:
        q = self.missoes_def.get(qid)
        et = self.etapa_atual(qid) if q else None
        if not et:
            if q and (self.missao(qid) or {}).get("estado") == "concluida":
                if qid == MISSAO_LENHA:
                    return ResultadoAcao(False, "missao_concluida", "Bram já recebeu a lenha de hoje.",
                                         "O jogador menciona lenha de novo, mas a entrega já foi feita antes; Bram lembra que o ensopado já foi pago.")
                return ResultadoAcao(False, "missao_concluida", "Você já concluiu essa missão.")
            return ResultadoAcao(False, "sem_missao", "Você não tem essa missão em andamento.")
        obj = et["objetivo"]
        if obj["tipo"] == "abater":
            return ResultadoAcao(False, "etapa_automatica", f"Contrato em andamento: {self.texto_etapa(qid)}.")
        if obj["tipo"] not in ("entregar", "pagar", "falar"):
            return ResultadoAcao(False, "etapa_automatica", "Essa etapa se cumpre explorando, não conversando.")
        if obj.get("npc") != npc:
            return ResultadoAcao(False, "npc_errado", "Isso não é com essa pessoa.")
        if obj["tipo"] == "entregar" and self.qtd(obj["item"]) < int(obj.get("qtd", 1)):
            nome_item = self.itens_def[obj["item"]]["nome"]
            if qid == MISSAO_LENHA:
                return ResultadoAcao(False, "entrega_recusada", "Você não carrega nenhum feixe de lenha.",
                                     "O jogador faz menção de entregar lenha, mas está de mãos vazias; Bram nota e lembra que a lenha fica no pátio dos fundos.")
            return ResultadoAcao(False, "falta_item", f"Falta: {nome_item} x{obj.get('qtd', 1)}.")
        if obj["tipo"] == "pagar" and self.cobre < int(obj["cobre"]):
            return ResultadoAcao(False, "sem_cobre", f"Você precisa de {obj['cobre']} cobres (tem {self.cobre}).",
                                 f"O jogador tenta pagar {obj['cobre']} cobres mas só tem {self.cobre}; a pessoa percebe que não dá.")
        if obj["tipo"] == "entregar":
            self._tirar(obj["item"], int(obj.get("qtd", 1)))
        if obj["tipo"] == "pagar":
            self.d["cobre"] = self.cobre - int(obj["cobre"])
        narrar, ganhos = self._aplicar_conclusao(qid, et)
        concluida = self.d["missoes"][qid]["estado"] == "concluida"
        if qid == MISSAO_LENHA and concluida:
            evento, msg = "lenha_entregue", f"Bram aceitou a lenha. Confiança de Bram: {round(self.confianca_bram * 100)}%. Ensopado liberado."
        else:
            evento = "missao_concluida" if concluida else "etapa_concluida"
            msg = f"Missão concluída: {q['titulo']}" if concluida else f"{q['titulo']}: etapa cumprida"
        return self._concluir_salvar(ResultadoAcao(True, evento, msg, narrar, itens_ganhos=ganhos))

    def entregar_lenha(self) -> ResultadoAcao:
        if self.etapa_lenha == "pendente":
            # Ainda na etapa de buscar: a "entrega" é de mãos vazias
            return ResultadoAcao(False, "entrega_recusada", "Você não carrega nenhum feixe de lenha.",
                                 "O jogador faz menção de entregar lenha, mas está de mãos vazias; Bram nota e lembra que a lenha fica no pátio dos fundos.")
        return self.concluir(MISSAO_LENHA, "bram")

    def comprar(self, item: str, npc: str, qtd: int = 1) -> ResultadoAcao:
        loja = (self.npcs_def.get(npc) or {}).get("loja")
        if not loja or item not in loja["itens"]:
            return ResultadoAcao(False, "fora_da_loja", "Isso não está à venda aqui.")
        qtd = max(1, min(10, int(qtd)))
        preco = int(self.itens_def[item].get("preco", 0)) * qtd
        if self.cobre < preco:
            return ResultadoAcao(False, "sem_cobre", f"Faltam {preco - self.cobre} cobres.")
        limite = int(self.itens_def[item].get("empilha", 99))
        if self.qtd(item) + qtd > limite:
            return ResultadoAcao(False, "bolsa_cheia", f"Você já carrega o máximo de {self.itens_def[item]['nome']}.")
        self.d["cobre"] = self.cobre - preco
        self._dar({item: qtd})
        return self._concluir_salvar(ResultadoAcao(True, "compra", f"Comprou {self.itens_def[item]['nome']} x{qtd} por {preco} cobres.", itens_ganhos={item: qtd}))

    def usar(self, item: str) -> ResultadoAcao:
        d = self.itens_def.get(item)
        if not d or d.get("tipo") != "consumivel":
            return ResultadoAcao(False, "nao_consumivel", "Isso não se usa assim.")
        if self.qtd(item) <= 0:
            return ResultadoAcao(False, "sem_item", "Você não tem isso na bolsa.")
        self._tirar(item, 1)
        efeito = dict(d.get("efeito") or {})
        st = self.d["status"]
        for k, spec in self.status_def.items():
            if k in efeito:
                st[k] = round(min(float(spec["max"]), float(st.get(k, 0)) + float(efeito[k])), 1)
        return self._concluir_salvar(ResultadoAcao(True, "item_usado", f"{d['nome']}: {self._descrever_efeito(efeito)}", efeito=efeito))

    @staticmethod
    def _descrever_efeito(efeito: dict[str, Any]) -> str:
        partes = [f"+{efeito[k]} {k}" for k in ("vida", "mana", "vigor", "calor") if k in efeito]
        if "buff" in efeito:
            partes.append(f"fôlego sem fim por {efeito['buff']['segundos']}s")
        return ", ".join(partes) or "nada demais"

    def visitar(self, marco: str) -> ResultadoAcao:
        validos = {m for q in self.missoes_def.values() for et in q["etapas"] for m in et["objetivo"].get("marcos", [])}
        if marco not in validos:
            return ResultadoAcao(False, "marco_desconhecido", "")
        if marco in self.d["marcos"]:
            return ResultadoAcao(False, "ja_visitado", "")
        self.d["marcos"].append(marco)
        return self._concluir_salvar(ResultadoAcao(True, "marco_visitado", f"Novo lugar conhecido: {marco}"))

    # -- combate -----------------------------------------------------------------------------------
    def nome_item(self, item: str) -> str:
        return str(self.itens_def.get(item, {}).get("nome", item))

    def _linhas_combate(self) -> list[str]:
        """Equipamento, caçadas e desmaios para o narrador (só o que existe; nada inventado)."""
        linhas = []
        arma = self.d["equipado"].get("arma")
        if arma:
            linhas.append(f"- Arma em mãos: {self.nome_item(arma)}.")
        abates = [(self.inimigos_def.get(t, {}).get("nome", t), n) for t, n in self.d["abates"].items() if n > 0]
        if abates:
            linhas.append("- Criaturas que o jogador já abateu fora da muralha: " + ", ".join(f"{nome} x{n}" for nome, n in abates) + ".")
        if self.d["derrotas"] > 0:
            linhas.append(f"- Já desmaiou em combate {self.d['derrotas']} vez(es) e foi resgatado.")
        return linhas

    def equipar(self, item: str) -> ResultadoAcao:
        d = self.itens_def.get(item)
        if not d or d.get("tipo") != "equipamento":
            return ResultadoAcao(False, "nao_equipavel", "Isso não se equipa.")
        if self.qtd(item) <= 0:
            return ResultadoAcao(False, "sem_item", "Você não tem isso na bolsa.")
        slot = str(d.get("slot") or "arma")
        self.d["equipado"][slot] = item
        return self._concluir_salvar(ResultadoAcao(True, "equipado", f"Equipou: {d['nome']}"))

    def _spawn_em_recarga(self, spawn: str, respawn_s: float) -> bool:
        agora = self.relogio()
        cooldown = max(0.0, respawn_s * FRACAO_COOLDOWN_SPAWN)
        ultimo = self._spawns_abatidos.get(spawn)
        if ultimo is not None and agora - ultimo < cooldown:
            return True
        self._spawns_abatidos.pop(spawn, None)
        self._spawns_abatidos[spawn] = agora
        if len(self._spawns_abatidos) > MAX_SPAWNS_GUARDADOS:
            for antigo in list(self._spawns_abatidos)[: len(self._spawns_abatidos) - MAX_SPAWNS_GUARDADOS]:
                del self._spawns_abatidos[antigo]
        return False

    def _sortear_recompensa(self, recompensa: dict[str, Any]) -> tuple[int, dict[str, int]]:
        """Cobre e drops sorteados no servidor; cada drop respeita o limite de empilhamento da bolsa."""
        faixa = recompensa.get("cobre") or [0, 0]
        cobre = self.rng.randint(int(faixa[0]), int(faixa[-1])) if faixa else 0
        ganhos: dict[str, int] = {}
        for drop in recompensa.get("drops") or []:
            item = str(drop.get("item") or "")
            spec = self.itens_def.get(item)
            if not spec or spec.get("tipo") in ("missao", "chave"):
                continue
            if self.rng.random() >= float(drop.get("chance", 0)):
                continue
            q = drop.get("qtd") or [1, 1]
            qtd = self.rng.randint(int(q[0]), int(q[-1]))
            cabe = int(spec.get("empilha", 99)) - self.qtd(item) - ganhos.get(item, 0)
            if min(qtd, cabe) > 0:
                ganhos[item] = ganhos.get(item, 0) + min(qtd, cabe)
        return cobre, ganhos

    def abater(self, tipo: str, spawn: str) -> ResultadoAcao:
        spec = self.inimigos_def.get(tipo)
        if not spec:
            return ResultadoAcao(False, "inimigo_desconhecido", "")
        if spec.get("treino"):
            return ResultadoAcao(False, "treino", "")
        if not _RE_SPAWN_ID.match(spawn):
            return ResultadoAcao(False, "spawn_invalido", "")
        if self._spawn_em_recarga(spawn, float(spec.get("respawn", 0))):
            return ResultadoAcao(False, "abate_repetido", "")
        cobre, ganhos = self._sortear_recompensa(spec.get("recompensa") or {})
        self.d["cobre"] = self.cobre + cobre
        self._dar(ganhos)
        self.d["abates"][tipo] = int(self.d["abates"].get(tipo, 0)) + 1
        contratos = []
        for qid in list(self.d["missoes"]):
            et = self.etapa_atual(qid)
            if et and et["objetivo"]["tipo"] == "abater" and et["objetivo"].get("alvo") == tipo:
                m = self.d["missoes"][qid]
                m["progresso"] = int(m.get("progresso", 0)) + 1
                contratos.append(qid)
        partes = [f"+{cobre} {'cobre' if cobre == 1 else 'cobres'}"] if cobre > 0 else []
        partes += [f"{self.nome_item(k)}{f' x{v}' if v > 1 else ''}" for k, v in ganhos.items()]
        msg = f"{spec['nome']} derrotado!" + (f" {', '.join(partes)}" if partes else "")
        progresso = {}
        for qid in contratos:
            prog = self.progresso_abate(qid)
            if prog:
                progresso[qid] = {"atual": prog[0], "total": prog[1]}
                msg += f" · {self.missoes_def[qid]['titulo']} ({prog[0]}/{prog[1]})"
        etapas_antes = {qid: int(self.d["missoes"][qid]["etapa"]) for qid in contratos}
        res = ResultadoAcao(True, "inimigo_abatido", msg, itens_ganhos=ganhos,
                            extra={"cobre": cobre, "inimigo": tipo, "contratos": progresso})
        self._concluir_salvar(res)
        for qid in contratos:
            if int(self.d["missoes"][qid]["etapa"]) != etapas_antes[qid]:
                progresso[qid]["etapa_cumprida"] = True
                res.mensagem += f" — etapa cumprida: {self.tarefa_da_missao(qid)}"
        return res

    def tarefa_da_missao(self, qid: str) -> str:
        """Próximo passo da missão (ou o texto de concluída)."""
        q = self.missoes_def.get(qid) or {}
        return self.texto_etapa(qid) or str(q.get("texto_concluida", "Concluída"))

    def derrota(self, local: str, extramuros: bool) -> ResultadoAcao:
        st = self.d["status"]
        for k in ("vida", "mana", "vigor"):
            if k in self.status_def:
                st[k] = round(float(self.status_def[k]["max"]) * FRACAO_RESTAURADA_DERROTA, 1)
        perda = min(PENALIDADE_COBRE_MAX, int(self.cobre * PENALIDADE_COBRE_FRACAO))
        self.d["cobre"] = self.cobre - perda
        self.d["derrotas"] = int(self.d["derrotas"]) + 1
        respawn = RESPAWN_ACAMPAMENTO if extramuros and MARCO_ACAMPAMENTO in self.d["marcos"] else RESPAWN_CIDADE
        onde = "no Acampamento dos Aventureiros, junto à fogueira" if respawn == RESPAWN_ACAMPAMENTO else "na enfermaria do Templo"
        msg = f"Você desmaiou e acordou {onde}." + (f" Perdeu {perda} {'cobre' if perda == 1 else 'cobres'} no caminho." if perda else "")
        return self._concluir_salvar(ResultadoAcao(True, "derrota", msg, (
            f"O jogador desmaiou em combate ({local[:40] or 'fora da muralha'}) e acordou {onde}, ferido e com a bolsa mais leve."),
            extra={"respawn": respawn, "cobre_perdido": perda}))

    def sincronizar_status(self, valores: dict[str, Any], mundo: dict[str, Any] | None = None) -> ResultadoAcao:
        st = self.d["status"]
        for k, spec in self.status_def.items():
            if k in valores:
                st[k] = round(play.num(valores[k], 0.0, float(spec["max"]), float(st.get(k, spec["inicial"]))), 1)
        if isinstance(mundo, dict):
            m = self.d["mundo"]
            m["hora"] = round(play.num(mundo.get("hora"), 0.0, 23.999, float(m.get("hora", MUNDO_INICIAL["hora"]))), 3)
            m["dia"] = int(play.num(mundo.get("dia"), 1, 100000, float(m.get("dia", 1))))
            m["chuva"] = round(play.num(mundo.get("chuva"), 0.0, 1.0, float(m.get("chuva", 0.0))), 3)
            m["alvo"] = round(play.num(mundo.get("alvo"), 0.0, 1.0, float(m.get("alvo", 0.0))), 3)
        self.relacao.salvar()
        return ResultadoAcao(True, "status_sincronizado", "")

    def executar(self, acao: str, corpo: dict[str, Any]) -> ResultadoAcao:
        npc = str(corpo.get("npc") or "").strip().lower()
        if acao == ACAO_RECOLHER:
            return self.recolher_lenha()
        if acao == ACAO_ENTREGAR:
            return self.entregar_lenha()
        if acao == ACAO_COLETAR:
            return self.coletar(str(corpo.get("alvo") or ""))
        if acao == ACAO_ACEITAR:
            return self.aceitar(str(corpo.get("missao") or ""), npc)
        if acao == ACAO_CONCLUIR:
            return self.concluir(str(corpo.get("missao") or ""), npc)
        if acao == ACAO_COMPRAR:
            return self.comprar(str(corpo.get("item") or ""), npc, int(play.num(corpo.get("qtd", 1), 1, 10, 1)))
        if acao == ACAO_USAR:
            return self.usar(str(corpo.get("item") or ""))
        if acao == ACAO_VISITAR:
            return self.visitar(str(corpo.get("marco") or ""))
        if acao == ACAO_SINCRONIZAR:
            status = corpo.get("status")
            return self.sincronizar_status(status if isinstance(status, dict) else {}, corpo.get("mundo"))
        if acao == ACAO_EQUIPAR:
            return self.equipar(str(corpo.get("item") or ""))
        if acao == ACAO_ABATER:
            return self.abater(str(corpo.get("inimigo") or "").strip().lower(), str(corpo.get("spawn") or "").strip().lower())
        if acao == ACAO_DERROTA:
            return self.derrota(str(corpo.get("local") or "").strip(), corpo.get("extramuros") is True)
        return ResultadoAcao(False, "acao_desconhecida", f"Ação desconhecida: {acao or '(vazia)'}")

    def reiniciar(self) -> None:
        self.relacao.d["jogo"] = self.estrutura_inicial()
        npcs = dict(self.relacao.d.get("npcs") or {})
        npcs["Bram"] = STATUS_BRAM_PADRAO
        self.relacao.d["npcs"] = npcs
        self.sincronizar_tarefa()
        self.relacao.salvar()
