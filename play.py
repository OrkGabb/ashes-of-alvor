#!/usr/bin/env python3
"""RPG de Mundo Aberto Isekai — Motor leve de Personas + Memória e Relação enxutas (Opção 1).

Fluxo de cada turno (1 única chamada ao LLM com streaming em tempo real):
  1. o jogador digita sua ação ou fala no terminal;
  2. o sistema monta o prompt combinando NARRATOR.md + arquivos da história (cenario.txt,
     jogador.txt, memoria.txt, abertura.txt) + personas da Luna e dos NPCs (ex.: Bram,
     dono da taverna Lanterna Torta) + estado atual de humor, relação e lembranças;
  3. o modelo narra a cena em streaming imediato (interpretando o mundo, os NPCs e a
     parceira Luna) e anexa ao final um bloco curto <estado>{...}</estado>, que é
     ocultado da tela em tempo real pelo FiltroStream;
  4. ao terminar o streaming, o estado (humor, intenção, relação slow-burn com passo
     máximo de ±0.05, atitude dos NPCs e novos fatos/lembranças) é atualizado
     automaticamente em luna/relacao.json e sincronizado em memoria.txt (com fallback
     heurístico caso um modelo pequeno omita a tag <estado>);
  5. histórico recente (luna/historico.json) e log da sessão (luna/sessao-AAAA-MM-DD.txt)
     são salvos.

Zero dependência do Family_AI ou de pacotes externos (apenas biblioteca padrão do Python 3.11+).

Uso:
  python play.py                     (LM Studio local, mesmo servidor do roleplay.ps1)
  python play.py --motor agy         (Gemini via CLI agy em chamada única)
  python play.py --motor teste       (sem modelo externo: valida streaming, cena e estado)
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import unicodedata
from dataclasses import dataclass
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parent

LMSTUDIO_URL = "http://127.0.0.1:1234/v1/chat/completions"
LMS_IDENTIFIER = "roleplay-local"
LMS_EXE = Path.home() / ".lmstudio" / "bin" / "lms.exe"
CONTEXTO_MINIMO = 4096
# Modelos do agy (IDs exatos aceitos por `agy --model`). O padrão é o leve; o roteador sobe para o médio só
# quando a conversa pede raciocínio (ver escolher_modelo).
MODELO_PADRAO = "gemini-4-hydrogen-low"
EFFORT_PADRAO = "low"
MODELO_PROFUNDO = "gemini-4-hydrogen-medium"
EFFORT_PROFUNDO = "medium"
CONFIG_DEFAULTS = {
    "Motor": "agy",
    "Pasta": "historias\\Isekai",
    "Modelo": MODELO_PADRAO,
    "Temperatura": "0.8",
    "MaxTokens": "700",
    "Contexto": "4096",
    "Gpu": "off",
}

CENARIO_PADRAO = """CENÁRIO: Fronteira de Alvor (Mundo de Vaeloria — Fantasia Isekai / Mundo Aberto)
Um continente vasto cortado por ruínas de uma civilização antiga, florestas densas,
estradas de terra batida e fendas por onde vaza mana bruto. Na borda da Mata Cinzenta
fica Cinzas de Alvor: uma cidade murada de fronteira com guilda de aventureiros,
mercado de relíquias, forjas, estalagens barulhentas e caravanas que chegam e saem
todo dia. De tempos em tempos, forasteiros vindos de outro mundo ("Despertos")
aparecem perto dos marcos de pedra antigos sem saber como chegaram ali.

O mundo é aberto: não há roteiro obrigatório. O jogador pode conversar na taverna,
arrumar bico ou quarto, explorar a cidade, aceitar contratos na Guilda, investigar
as ruínas com ou sem companhia, ou simplesmente tentar sobreviver um dia de cada vez.

ELENCO E PERSONAS PRINCIPAIS:
- Luna, 20 anos (Exploradora de Ruínas e Cartógrafa | Parceira / Companion):
  Trabalha por conta própria mapeando zonas instáveis de mana e buscando relíquias
  pequenas que a Guilda evita. Usa um caderno de couro cheio de mapas rabiscados e
  uma lanterna de cristal presa ao cinto. Observadora, curiosa, irônica e direta;
  repara em cada gesto, gíria, roupa estranha ou contradição. Fala de jeito natural
  e espontâneo, como uma jovem brasileira real (sem pompa medieval artificial).
  Tem vontade e rotina próprias: provoca, discorda quando acha uma ideia furada e
  não confia de graça em quem acabou de aparecer. Segredo (só revela se houver muita
  confiança): achou um fragmento de mapa de uma câmara selada sob o Marco da Estrada
  Velha, mas ainda não sabe como ativar o selo.
- Bram, 44 anos (Dono e Taverneiro da Estalagem Lanterna Torta):
  Ex-batedor veterano da fronteira, ombros largos, barba curta grisalha, cicatriz na
  sobrancelha esquerda e um pano sempre no ombro secando canecos de estanho atrás do
  balcão. Pragmático, calmo e observador, com humor seco de quem já viu todo tipo de
  aventureiro e Desperto cruzar a porta sem um cobre no bolso. Fala de forma direta e
  cotidiana. Serve ensopado quente e cerveja da casa, conhece os boatos da região,
  implica de leve com a Luna por espalhar mapas no balcão e sabe negociar (cobra em
  moedas de cobre, mas aceita trabalho no salão, lenha ou pequenos favores).
- Outros habitantes de Cinzas de Alvor:
  - Velho Darian: relojoeiro e avaliador de relíquias que compra achados da Luna e
    sempre tenta pechinchar.
  - Maren: veterana prática e sem paciência que cuida do quadro de contratos e dos
    registros na Praça da Guilda.

LUGARES CONHECIDOS NA REGIÃO:
- Estalagem Lanterna Torta: salão aquecido por lareira de pedra, cheiro de ensopado,
  mesas de madeira riscada, quartos baratos no andar de cima e conversa até tarde.
- Marco da Estrada Velha: monólito de pedra rachada a vinte minutos do portão norte,
  onde o ar cheira a ozônio depois de anomalias de mana.
- Portão Norte e Praça da Guilda: ponto de chegada de caçadores, mercadores e novatos.
- Oficina do Velho Darian: viela perto do mercado, cheia de lentes e artefatos antigos.

CENA INICIAL:
Começo de noite chuvosa na Estalagem Lanterna Torta. Você acabou de entrar no salão
depois de despertar perto do Marco da Estrada Velha. Bram seca um caneco atrás do
balcão e te avalia de canto de olho; na ponta do balcão, Luna revisa seus mapas à
luz da lareira e te mede dos pés à cabeça com curiosidade irônica.
"""

JOGADOR_PADRAO = """PERSONAGEM DO JOGADOR (edite antes de jogar ou revele em cena; o que ficar em branco não será inventado)
Nome:
Idade: 20
Origem: veio de outro mundo (despertou há pouco perto de Cinzas de Alvor)
Aparência:
Jeito:
O que traz consigo:
"""

HISTORICO_POR_NPC = 12     # mensagens guardadas por interlocutor (6 trocas); o modelo recebe até ~3500 caracteres

MEMORIA_PADRAO = """FATOS CONFIRMADOS:
- Você acabou de despertar nos arredores de Cinzas de Alvor, perto do Marco da Estrada Velha, em um mundo que não reconhece, e entrou na Estalagem Lanterna Torta para sair da chuva.
- Luna (exploradora e cartógrafa) e Bram (dono da taverna) estão no balcão; eles ainda não sabem seu nome nem de onde você veio.

RELAÇÕES (atualizadas a cada turno e com /nota):
- Luna: desconhecidos (humor: curiosa e irônica).
- Bram: atento atrás do balcão, avaliando o recém-chegado.
"""

ABERTURA_PADRAO = """CENA ATUAL (edite à vontade):
Começo de noite na Estalagem Lanterna Torta, dentro dos muros de Cinzas de Alvor. Lá fora,
uma chuva fina escurece o calçamento de pedra; aqui dentro, a lareira estala e o salão
cheira a ensopado quente, pão assado e madeira úmida. Atrás do balcão riscado, Bram — o
dono da taverna — seca um caneco de estanho com um pano no ombro, te medindo de canto de
olho desde que você passou pela porta depois de despertar perto do Marco da Estrada Velha.
Na ponta do balcão, ao lado de uma lanterna de cristal apagada, Luna está debruçada sobre
um caderno de couro cheio de mapas rabiscados. Ela ergue o olhar, apoia o queixo na mão e
repara nas suas roupas de outro mundo e no seu jeito de quem acabou de cair ali do nada.
Bram bate o pano no balcão e apoia os cotovelos na madeira.
— Porta aberta entra vento, forasteiro — diz Bram, num tom calmo e rouco, apontando com o
queixo para os bancos vagos perto do balcão. — Se veio atrás de fogo e tigela quente,
encosta aí. Só me diz antes se tem cobre no bolso ou se é mais um que acordou no Marco
sem saber nem o próprio nome.
Ao lado dele, Luna gira o lápis de carvão entre os dedos e solta um meio sorriso irônico,
esperando para ver sua reação.
"""

PADROES_HISTORIA = {
    "cenario.txt": CENARIO_PADRAO,
    "jogador.txt": JOGADOR_PADRAO,
    "memoria.txt": MEMORIA_PADRAO,
}


# ---------------------------------------------------------------------------
# utilidades


def ler_texto(p: Path) -> str:
    return p.read_text(encoding="utf-8-sig").strip() if p.is_file() else ""


def gravar_atomico(path: Path, texto: str) -> None:
    """Grava num arquivo temporário ao lado e troca de uma vez (os.replace): uma queda no meio da
    gravação deixa o arquivo anterior inteiro, nunca um save pela metade."""
    tmp = path.with_name(f".{path.name}.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(texto)
        f.flush()
        os.fsync(f.fileno())
    for tentativa in range(5):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            # Windows: outro processo (antivírus, indexador) segurando o destino por um instante
            if tentativa == 4:
                raise
            time.sleep(0.05 * (tentativa + 1))


def preservar_ilegivel(path: Path) -> None:
    """Guarda uma cópia de um arquivo ilegível antes que o estado padrão o sobrescreva."""
    try:
        if path.is_file() and path.stat().st_size > 0:
            shutil.copyfile(path, path.with_name(f"{path.stem}.corrompido-{datetime.now():%Y%m%d-%H%M%S}{path.suffix}"))
    except OSError:
        pass


def num(v: Any, lo: float, hi: float, default: float = 0.0) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(f):
        return default
    return max(lo, min(hi, f))


def normalizar(s: str) -> str:
    s = unicodedata.normalize("NFKD", s.casefold())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return " ".join(re.sub(r"[^\w\s]", " ", s).split())


def ler_config() -> dict[str, str]:
    cfg = dict(CONFIG_DEFAULTS)
    for linha in ler_texto(ROOT / "config.ini").splitlines():
        m = re.match(r"^\s*(\w+)\s*=(.*)$", linha)
        if m and m.group(1) in cfg and m.group(2).strip():
            cfg[m.group(1)] = m.group(2).strip()
    return cfg


def aviso(msg: str) -> None:
    print(f"[!] {msg}")


# ---------------------------------------------------------------------------
# estado leve da cena, relação slow-burn e memória (sem banco externo)

PASSO_MAX = 0.05  # slow-burn: nenhum turno move a relação mais que isso
ESTAGIOS = [
    (0.15, "desconhecidos",
     "Não há intimidade. Nada de flerte declarado; no máximo curiosidade, teste ou ironia leve."),
    (0.35, "conhecidos",
     "Reconhecem um ao outro. Conversa casual, alguma provocação; ainda sem confidências nem segredos."),
    (0.55, "parceria em formação",
     "Ela começa a se abrir em detalhes pequenos. Interesse pode aparecer só em sinais sutis."),
    (0.75, "aliados próximos",
     "Confiança real conquistada em cena. Tensão romântica pode existir, sem avanços sem iniciativa clara."),
    (0.90, "algo a mais no ar",
     "Os dois sabem que há algo. Ainda assim, cada passo é uma escolha, não automático."),
    (1.01, "íntimos",
     "Intimidade estabelecida, conquistada pela história; continue coerente com ela."),
]


_FATOS_IGNORADOS = {
    "", "vazio", "nenhum", "nenhuma", "nada", "null", "none", "na", "n a",
    "sem fato", "sem fatos", "sem fato novo", "sem fatos novos", "sem novidade",
    "sem novidades", "nenhum fato", "nenhum fato novo", "nenhum fato concreto",
    "nada novo", "nada de novo", "nao ha", "inalterado", "mesmo",
}

_NOMES_IGNORADOS = {
    "um", "uma", "novo", "nova", "calouro", "caloura", "forasteiro", "forasteira",
    "desperto", "desperta", "cara", "garoto", "garota", "homem", "mulher", "pessoa",
    "alguem", "ninguem", "quem", "aquele", "aquela", "eu", "aqui", "so", "apenas",
}


def limpar_fato(valor: Any) -> str:
    """Retorna o fato limpo ou string vazia se for placeholder ('vazio', 'nenhum', etc.)."""
    limpo = " ".join(str(valor or "").strip().split())[:240]
    chave = normalizar(limpo)
    if not chave or len(chave) < 4 or chave in _FATOS_IGNORADOS:
        return ""
    if chave.startswith(("novo fato concreto", "nenhum fato", "sem fato", "nada relevante")):
        return ""
    return limpo


def _limpar_campo_estado(valor: Any, max_len: int, prefixos_template: tuple[str, ...] = ()) -> str:
    limpo = " ".join(str(valor or "").strip().split())[:max_len]
    norm = normalizar(limpo)
    if not norm or norm in ("vazio", "null", "none", "n a") or limpo.strip(".") == "":
        return ""
    if prefixos_template and norm.startswith(prefixos_template):
        return ""
    return limpo


class Relacao:
    """Mantém o estado enxuto de relação (slow-burn), humor da Luna, NPCs e lembranças."""

    def __init__(self, path: Path, eh_isekai: bool = True, npcs_iniciais: dict[str, str] | None = None) -> None:
        self.path = path
        self.eh_isekai = eh_isekai
        intencao_padrao = (
            "observar como o forasteiro reage ao Bram e sondar de onde ele veio"
            if eh_isekai else "observar como você age ao chegar e testar sua reação"
        )
        npcs_padrao = dict(npcs_iniciais) if npcs_iniciais else (
            {"Bram": "atento atrás do balcão, avaliando se o recém-chegado tem cobre ou conversa honesta"}
            if eh_isekai else {}
        )
        self.d: dict[str, Any] = {
            "proximidade": 0.0,
            "confianca": 0.0,
            "tensao": 0.0,
            "humor": "curiosa e irônica",
            "intencao": intencao_padrao,
            "npcs": npcs_padrao,
            "lembrancas": [],
            "tarefa": "buscar lenha nos fundos em troca do ensopado" if eh_isekai else "",
            "turnos": 0,
            "historico": [],
        }
        if path.is_file():
            try:
                salvo = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(salvo, dict):
                    self.d.update(salvo)
                    if not self.d.get("tarefa") and eh_isekai:
                        self.d["tarefa"] = "buscar lenha nos fundos em troca do ensopado"
                    if not isinstance(self.d.get("npcs"), dict):
                        self.d["npcs"] = dict(npcs_padrao)
                    else:
                        for k, v in npcs_padrao.items():
                            self.d["npcs"].setdefault(k, v)
                    if not isinstance(self.d.get("lembrancas"), list):
                        self.d["lembrancas"] = []
                    else:
                        self.d["lembrancas"] = [
                            f for f in (limpar_fato(x) for x in self.d["lembrancas"]) if f
                        ][-15:]
            except (OSError, ValueError):
                preservar_ilegivel(path)
                aviso("relacao.json ilegível; cópia guardada como relacao.corrompido-*.json; recomeçando o estado do zero.")

    def estagio(self) -> tuple[str, str]:
        p = num(self.d.get("proximidade", 0.0), 0.0, 1.0)
        for teto, nome, ritmo in ESTAGIOS:
            if p < teto:
                return nome, ritmo
        return ESTAGIOS[-1][1], ESTAGIOS[-1][2]

    def tag_exemplo(self, deltas: dict[str, float] | None = None, fato: str = "") -> str:
        npcs = self.d.get("npcs") or {}
        bram_val = str(npcs.get("Bram") or next(iter(npcs.values()), "atento em cena"))
        payload: dict[str, Any] = {
            "humor": str(self.d.get("humor") or "curiosa e irônica"),
            "intencao": str(self.d.get("intencao") or "observar a cena"),
            "relacao": deltas or {"proximidade": 0.0, "confianca": 0.0, "tensao": 0.0},
            "bram": bram_val,
            "fato": fato,
        }
        return f"<estado>{json.dumps(payload, ensure_ascii=False)}</estado>"

    def aplicar(self, estado: dict[str, Any]) -> dict[str, float]:
        deltas = estado.get("relacao") if isinstance(estado.get("relacao"), dict) else {}
        aplicado: dict[str, float] = {}
        for k in ("proximidade", "confianca", "tensao"):
            atual = num(self.d.get(k, 0.0), 0.0, 1.0)
            dv = num(deltas.get(k, 0.0), -PASSO_MAX, PASSO_MAX)
            novo = num(atual + dv, 0.0, 1.0)
            aplicado[k] = round(novo - atual, 3)
            self.d[k] = round(novo, 3)

        humor = _limpar_campo_estado(estado.get("humor"), 120, ("humor atual",))
        if humor:
            self.d["humor"] = humor

        intencao = _limpar_campo_estado(estado.get("intencao"), 240, ("o que luna pretende",))
        if intencao:
            self.d["intencao"] = intencao

        npcs = dict(self.d.get("npcs") or {})
        bram = _limpar_campo_estado(estado.get("bram"), 180, ("atitude atual",))
        if bram and (self.eh_isekai or "Bram" in npcs):
            npcs["Bram"] = bram
        if isinstance(estado.get("npcs"), dict):
            for nome_npc, atitude in estado["npcs"].items():
                at_str = _limpar_campo_estado(atitude, 180, ("atitude atual",))
                nome_limpo = str(nome_npc or "").strip()[:40]
                if nome_limpo and nome_limpo.lower() != "luna" and at_str:
                    npcs[nome_limpo] = at_str
        self.d["npcs"] = npcs

        fato = limpar_fato(estado.get("fato") or estado.get("memoria") or "")
        if fato:
            self.adicionar_lembranca(fato)

        tarefa = _limpar_campo_estado(estado.get("tarefa"), 180, ("tarefa atual",))
        if tarefa:
            self.d["tarefa"] = tarefa

        self.d["turnos"] = int(self.d.get("turnos", 0)) + 1
        self.d["historico"] = (list(self.d.get("historico", [])) + [
            {
                "turno": self.d["turnos"],
                "deltas": aplicado,
                "humor": self.d["humor"],
                "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }
        ])[-30:]
        self.salvar()
        return aplicado

    def adicionar_lembranca(self, texto: str) -> bool:
        limpo = limpar_fato(texto)
        if not limpo:
            return False
        chave = normalizar(limpo)
        atuais: list[str] = [str(x) for x in (self.d.get("lembrancas") or []) if str(x).strip()]
        existentes_norm = {normalizar(x) for x in atuais}
        if chave in existentes_norm:
            return False
        atuais.append(limpo)
        self.d["lembrancas"] = atuais[-15:]
        return True

    def salvar(self) -> None:
        gravar_atomico(self.path, json.dumps(self.d, ensure_ascii=False, indent=2))


def _extrair_npcs_memoria(texto_memoria: str) -> dict[str, str]:
    linhas = texto_memoria.splitlines()
    idx_rel = next(
        (i for i, ln in enumerate(linhas) if re.match(r"^\s*RELA[ÇC][ÕO]ES\b", ln, flags=re.I)),
        -1,
    )
    if idx_rel < 0:
        return {}
    npcs: dict[str, str] = {}
    for ln in linhas[idx_rel + 1:]:
        m = re.match(r"^\s*-\s*([^:]{1,40}):\s*(.+?)\s*$", ln)
        if m:
            nome = m.group(1).strip()
            status = m.group(2).strip().rstrip(".")
            if nome and nome.lower() != "luna" and status:
                npcs[nome] = status
    return npcs


def _gerar_abertura_do_cenario(texto_cenario: str) -> str:
    m = re.search(r"CENA INICIAL\s*:\s*(.+)$", texto_cenario, flags=re.S | re.I)
    if m and m.group(1).strip():
        return f"CENA ATUAL (edite à vontade):\n{m.group(1).strip()}\n"
    return ABERTURA_PADRAO


class Cena:
    def __init__(self, pasta: Path) -> None:
        self.pasta = pasta
        self.pasta.mkdir(parents=True, exist_ok=True)
        for nome_arq, conteudo_padrao in PADROES_HISTORIA.items():
            arq = self.pasta / nome_arq
            if not arq.is_file():
                arq.write_text(conteudo_padrao, encoding="utf-8")
        self.dir = pasta / "luna"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.hist_path = self.dir / "historico.json"
        cenario_txt = ler_texto(self.pasta / "cenario.txt")
        self.eh_isekai = (
            not cenario_txt
            or any(p in cenario_txt.lower() for p in ("alvor", "vaeloria", "lanterna torta", "bram"))
        )
        npcs_mem = _extrair_npcs_memoria(ler_texto(self.pasta / "memoria.txt"))
        self.relacao = Relacao(self.dir / "relacao.json", eh_isekai=self.eh_isekai, npcs_iniciais=npcs_mem)
        abertura = self.dir / "abertura.txt"
        if not abertura.is_file():
            abertura.write_text(
                ABERTURA_PADRAO if self.eh_isekai else _gerar_abertura_do_cenario(cenario_txt),
                encoding="utf-8",
            )
        # Um histórico por interlocutor (id do NPC; "" = narrador geral do modo terminal). Conversar com a Rosa
        # não carrega a conversa com o Bram, nem no modelo nem na janela do jogo. Formato antigo (lista única)
        # migra para o histórico geral.
        self.historicos: dict[str, list[dict[str, str]]] = {}
        if self.hist_path.is_file():
            try:
                bruto = json.loads(self.hist_path.read_text(encoding="utf-8"))
                por_npc = bruto.get("por_npc", {}) if isinstance(bruto, dict) else {"": bruto}
                for chave, msgs in por_npc.items():
                    limpas = [
                        {"role": m["role"], "content": m["content"]}
                        for m in (msgs if isinstance(msgs, list) else [])
                        if isinstance(m, dict)
                        and m.get("role") in ("user", "assistant")
                        and isinstance(m.get("content"), str)
                    ][-HISTORICO_POR_NPC:]
                    if limpas:
                        self.historicos[str(chave)] = limpas
            except (OSError, ValueError, TypeError, KeyError, AttributeError):
                preservar_ilegivel(self.hist_path)
                aviso("historico.json ilegível; começando sem histórico recente.")

    @property
    def historico(self) -> list[dict[str, str]]:
        """Histórico do narrador geral (modo terminal)."""
        return self.historicos.get("", [])

    @historico.setter
    def historico(self, msgs: list[dict[str, str]]) -> None:
        if msgs:
            self.historicos[""] = list(msgs)
        else:
            self.historicos.pop("", None)

    def historico_de(self, npc: str = "") -> list[dict[str, str]]:
        return self.historicos.get(npc, [])

    def limpar_historicos(self) -> None:
        self.historicos = {}
        self.gravar_historicos()

    def gravar_historicos(self) -> None:
        gravar_atomico(self.hist_path, json.dumps({"versao": 2, "por_npc": self.historicos}, ensure_ascii=False, indent=2))

    def texto_abertura(self) -> str:
        bruto = ler_texto(self.dir / "abertura.txt")
        return re.sub(r"^CENA ATUAL[^\n]*\n+", "", bruto, flags=re.I).strip()

    def arquivos_contexto(self) -> str:
        partes, total = [], 0
        arquivos = sorted(
            p for p in self.pasta.iterdir()
            if p.is_file() and p.suffix.lower() in (".txt", ".md") and not p.name.startswith("sessao-")
        )
        arquivos.append(self.dir / "abertura.txt")
        for p in arquivos:
            texto = ler_texto(p)
            if not texto:
                continue
            total += len(texto)
            if total > 7000:
                aviso(f"Contexto acima de 7000 caracteres; {p.name} ficou de fora.")
                break
            partes.append(f"### {p.name}\n{texto}")
        return "\n\n".join(partes)

    def historico_recente(self, limite: int, npc: str = "") -> list[dict[str, str]]:
        recente = list(self.historico_de(npc))
        while recente and sum(len(m["content"]) for m in recente) > limite:
            recente = recente[2:] if len(recente) > 2 else []
        return recente

    def mensagens_para_llm(self, texto_usuario: str, limite: int = 3500, npc: str = "") -> list[dict[str, str]]:
        """Monta o histórico para o LLM semeando o formato <estado> nas respostas anteriores.
        Com npc, só a conversa com aquele NPC (sem a cena de abertura da estalagem)."""
        recente = self.historico_recente(limite, npc)
        tag_atual = self.relacao.tag_exemplo()
        if not recente and npc:
            return [{"role": "user", "content": texto_usuario}]
        if not recente:
            abertura_txt = self.texto_abertura()
            if abertura_txt:
                return [
                    {"role": "user", "content": "[Você entra na cena inicial.]"},
                    {"role": "assistant", "content": f"{abertura_txt}\n{tag_atual}"},
                    {"role": "user", "content": texto_usuario},
                ]
            return [{"role": "user", "content": texto_usuario}]

        formatadas: list[dict[str, str]] = []
        for m in recente:
            if m["role"] == "assistant" and "<estado>" not in m["content"]:
                formatadas.append({"role": "assistant", "content": f"{m['content']}\n{tag_atual}"})
            else:
                formatadas.append({"role": m["role"], "content": m["content"]})
        formatadas.append({"role": "user", "content": texto_usuario})
        return formatadas

    def sincronizar_memoria_txt(self, novo_fato: str = "") -> None:
        """Mantém memoria.txt sincronizado com o estágio da relação, NPCs e fatos descobertos."""
        mem_path = self.pasta / "memoria.txt"
        texto = ler_texto(mem_path) or MEMORIA_PADRAO.strip()
        linhas = texto.splitlines()

        estagio_luna, _ = self.relacao.estagio()
        humor_luna = str(self.relacao.d.get("humor") or "curiosa e irônica")
        npcs_atuais = dict(self.relacao.d.get("npcs") or {})

        idx_rel = next(
            (i for i, ln in enumerate(linhas) if re.match(r"^\s*RELA[ÇC][ÕO]ES\b", ln, flags=re.I)),
            -1,
        )
        linhas_fatos = linhas[:idx_rel] if idx_rel >= 0 else list(linhas)
        notas_resgatadas: list[str] = []
        if idx_rel >= 0:
            for ln in linhas[idx_rel + 1:]:
                s = ln.strip()
                if not s:
                    continue
                m_rel = re.match(r"^-\s*([^:]{1,40}):\s*(.+?)\s*$", s)
                if m_rel:
                    nome_npc = m_rel.group(1).strip()
                    status_npc = m_rel.group(2).strip().rstrip(".")
                    if nome_npc.lower() != "luna" and nome_npc not in npcs_atuais and status_npc:
                        npcs_atuais[nome_npc] = status_npc
                else:
                    notas_resgatadas.append(s.lstrip("- ").strip())

        self.relacao.d["npcs"] = npcs_atuais

        while linhas_fatos and not linhas_fatos[-1].strip():
            linhas_fatos.pop()
        if not linhas_fatos:
            linhas_fatos = ["FATOS CONFIRMADOS:"]

        for candidato in [*notas_resgatadas, novo_fato]:
            fato_limpo = limpar_fato(candidato)
            if not fato_limpo:
                continue
            chave = normalizar(fato_limpo)
            existentes = {normalizar(ln.lstrip("- ").strip()) for ln in linhas_fatos if ln.strip()}
            if chave not in existentes:
                while len("\n".join(linhas_fatos)) + len(fato_limpo) > 1800 and len(linhas_fatos) > 3:
                    # Preserva o cabeçalho e os 2 fatos iniciais, rotacionando os mais antigos
                    del linhas_fatos[3]
                linhas_fatos.append(f"- {fato_limpo}")

        bloco_rel = [
            "",
            "RELAÇÕES (atualizadas a cada turno e com /nota):",
            f"- Luna: {estagio_luna} (humor: {humor_luna}).",
        ]
        if self.eh_isekai or "Bram" in npcs_atuais:
            bram_status = str(npcs_atuais.get("Bram") or "atento atrás do balcão").rstrip(".")
            bloco_rel.append(f"- Bram: {bram_status}.")
        for nome_npc, status_npc in npcs_atuais.items():
            if nome_npc != "Bram":
                bloco_rel.append(f"- {nome_npc}: {str(status_npc).rstrip('.')}.")

        novo_conteudo = "\n".join(linhas_fatos + bloco_rel).strip() + "\n"
        gravar_atomico(mem_path, novo_conteudo)

    def salvar_turno(self, texto: str, resposta: str, modelo: str, estado: dict[str, Any], npc: str = "") -> dict[str, float]:
        deltas = self.relacao.aplicar(estado)
        fato = limpar_fato(estado.get("fato") or estado.get("memoria") or "")
        self.sincronizar_memoria_txt(fato)

        self.historicos[npc] = (
            self.historico_de(npc)
            + [{"role": "user", "content": texto}, {"role": "assistant", "content": resposta}]
        )[-HISTORICO_POR_NPC:]
        self.gravar_historicos()
        log = self.dir / f"sessao-{datetime.now():%Y-%m-%d}.txt"
        with log.open("a", encoding="utf-8") as f:
            f.write(f"\n[{datetime.now():%H:%M:%S}] {modelo}\nVocê: {texto}\nNarrador: {resposta}\n")
        return deltas


# ---------------------------------------------------------------------------
# prompt de chamada única (Narrador + Personas + Tag de Estado leve)

DIRETRIZES_PERSONAS = """# Diretrizes das Personas em Cena (Mundo Aberto Isekai)
- **Luna (20 anos, exploradora de ruínas e cartógrafa | parceira/companion)**:
  - Curiosa, observadora, irônica e direta. Fala em português do Brasil natural e espontâneo, como uma jovem adulta real, sem formalidade medieval artificial.
  - Tem vida, rotina e opinião própria: não é guia servil. Pode provocar, testar, discordar, mudar de assunto ou interagir com Bram e outros NPCs por conta própria. Romance e confiança em ritmo *slow-burn*.
- **Bram (44 anos, dono e taverneiro da Estalagem Lanterna Torta)**:
  - Ex-batedor veterano, pragmático, calmo e observador, com humor seco. Cuida do balcão, conhece os boatos de Cinzas de Alvor e negocia de forma realista (moedas de cobre, trabalho no salão ou pequenos favores).
- **Outros NPCs e o Mundo**:
  - Qualquer NPC presente reage com vontade própria e coerência. Conversar com a parceira e com as pessoas do mundo é algo cotidiano, fluido e vivo."""

DIRETRIZES_PERSONAS_GERAL = """# Diretrizes das Personas em Cena
- **Luna e NPCs do cenário**:
  - Atue de acordo com as personalidades definidas em `cenario.txt`. Falam em português do Brasil natural e espontâneo, com vontade própria, rotina e opiniões reais.
  - Romance e confiança em ritmo *slow-burn*: crescem gradualmente pelas escolhas em cena."""


def bloco_cena(contexto: dict[str, Any], npcs_status: dict[str, str]) -> str:
    """Cena atual vinda do jogo 3D: onde, quando, com quem o jogador fala e quem mais está por perto."""
    alvo = contexto.get("interlocutor") or {}
    nome = str(alvo.get("nome") or "")
    linhas = [
        "# Cena Atual (fatos de fundo: use só se tiverem a ver com o que o jogador disse; não descreva)",
        f"Local: {contexto.get('local') or 'Cinzas de Alvor'} · Hora: {contexto.get('hora') or 'noite'} · Clima: {contexto.get('clima') or 'chuva fina'}",
    ]
    if nome:
        linhas.append(f"INTERLOCUTOR: {nome} — {alvo.get('titulo', '')}. {alvo.get('persona', '')}")
        linhas.append(f"Atitude atual de {nome} com o jogador: {npcs_status.get(nome) or 'neutra, ainda formando opinião'}. Agora: {alvo.get('atividade') or 'parado'}.")
    presentes = [p for p in contexto.get("presentes") or [] if p.get("nome") and p.get("nome") != nome]
    if presentes:
        linhas.append("Também presentes (só eles podem agir ou falar além do interlocutor): " + "; ".join(
            f"{p['nome']} ({p.get('atividade') or 'por perto'})" for p in presentes))
        for p in presentes:
            if p.get("persona"):
                linhas.append(f"- {p['nome']}: {p['persona']}")
    else:
        linhas.append("Ninguém mais por perto além do interlocutor.")
    linhas.append("Foque a resposta no INTERLOCUTOR. Personagens ausentes não aparecem nem falam; a Luna só participa se estiver presente.")
    return "\n".join(linhas)


def tarefa_conversa(nome: str) -> str:
    """Conversa direta com um NPC no jogo 3D: fala e resposta, sem narração de cena."""
    quem = nome or "o NPC"
    return f"""# Sua Tarefa: conversa direta com {quem} (1 única resposta + tag <estado> na última linha)
Isto é uma CONVERSA, não uma cena narrada. Ignore aqui a regra de narrar em segunda pessoa: escreva o que {quem} responde.
1. A fala é o centro: pelo menos 80% do texto é o que {quem} diz, em primeira pessoa, no jeito e no vocabulário dele(a).
2. Tamanho de conversa real: 1 a 4 frases, até cerca de 70 palavras. Só se estenda quando o jogador pedir explicação, história ou detalhes.
3. No máximo UM gesto ou reação curta entre asteriscos, com até 10 palavras, e só quando acrescentar algo (ex.: *cruza os braços*). Nada de descrever clima, luz, cheiros, cenário, o que os outros estão fazendo, nem pensamentos internos.
4. NUNCA escreva falas, ações, pensamentos ou sentimentos do jogador.
5. Outro personagem presente só fala se for chamado ou se for muito natural: uma linha curta começando pelo nome ("Bram: ...").
6. Sem perguntas burocráticas de encerramento e sem títulos; termine na fala."""


def montar_sistema_narrador(cena: Cena, contexto: dict[str, Any] | None = None) -> str:
    gemini = ler_texto(ROOT / "NARRATOR.md")
    r = cena.relacao.d
    estagio_nome, estagio_ritmo = cena.relacao.estagio()
    npcs = r.get("npcs") or {}
    resumo_npcs = "; ".join(f"{k}: {v}" for k, v in npcs.items()) or "nenhum NPC adicional registrado"
    lembrancas = "; ".join(str(t) for t in (r.get("lembrancas") or [])[-8:]) or "nenhuma registrada ainda"
    diretrizes = DIRETRIZES_PERSONAS if cena.eh_isekai else DIRETRIZES_PERSONAS_GERAL
    nome_alvo = ""
    if contexto:
        nome_alvo = str((contexto.get("interlocutor") or {}).get("nome") or "")
        diretrizes = bloco_cena(contexto, {str(k): str(v) for k, v in npcs.items()})
        tag = ('<estado>{{"humor": "humor atual da Luna", "intencao": "intenção imediata da Luna", '
               '"relacao": {{"proximidade": 0.0, "confianca": 0.0, "tensao": 0.0}}, '
               f'"npc": "atitude atual de {nome_alvo or "quem fala"} com o jogador", "fato": ""}}</estado>')
        regra_luna = " Se a Luna NÃO estiver presente, mantenha humor/intenção dela como estão e use 0.0 em todos os campos de \"relacao\"."
    else:
        tag = ('<estado>{{"humor": "humor atual da Luna", "intencao": "intenção imediata da Luna", '
               '"relacao": {{"proximidade": 0.0, "confianca": 0.0, "tensao": 0.0}}, "bram": "atitude atual de Bram ou NPC em cena", "fato": ""}}</estado>')
        regra_luna = ""

    if contexto:
        tarefa = f"""{tarefa_conversa(nome_alvo)}
7. Na última linha, feche OBRIGATORIAMENTE com uma única tag `<estado>...</estado>` em JSON de uma linha (use `""` em `"fato"` se não houver fato novo).{regra_luna}"""
    else:
        tarefa = f"""# Sua Tarefa (1 Única Resposta: Narração + Tag <estado> na última linha)
1. Escreva APENAS a continuação imediata da cena no presente e em segunda pessoa ("você"), em português do Brasil, de forma concisa (2 a 4 parágrafos curtos, cerca de 120 a 220 palavras).
2. Interprete o ambiente, a Luna e os NPCs presentes de forma orgânica, com diálogos naturais.
3. NUNCA escreva falas, pensamentos, sentimentos ou decisões pelo jogador ("você"). Não invente dados em branco da ficha.
4. Termine a narração diretamente na fala ou ação de um personagem, SEM perguntas ao jogador ("O que você faz?" etc.) e SEM títulos como "Estado Atual:".
5. Na última linha, feche OBRIGATORIAMENTE com uma única tag `<estado>...</estado>` em JSON de uma linha (use `""` em `"fato"` se não houver fato novo).{regra_luna}"""

    return f"""{gemini}

# Contexto do Mundo e da História
{cena.arquivos_contexto()}

{diretrizes}

# Contexto Interno de Relação e Cena (NÃO escreva listas de estado visíveis na narração)
Relação atual da Luna com o jogador: {estagio_nome} (proximidade={float(r.get('proximidade', 0.0)):.2f}, confiança={float(r.get('confianca', 0.0)):.2f}, tensão={float(r.get('tensao', 0.0)):.2f}). {estagio_ritmo}
Postura atual da Luna: {r.get('humor') or 'curiosa e irônica'} | Intenção da Luna: {r.get('intencao') or 'observar você'}.
NPCs em cena: {resumo_npcs}.
Lembranças recentes (use só se o assunto pedir): {lembrancas}.

{tarefa}
{tag.replace("{{", "{").replace("}}", "}")}"""


# ---------------------------------------------------------------------------
# filtro de streaming e extração resiliente de narração + estado

_RE_INICIO_ESTADO_STREAM = re.compile(
    r"<(?:estado|status|state)\b[^>]*>"
    r"|```+"
    r"|\n\s*(?:\*\*|#+)?\s*Estado\s+Atual\s*(?:\*\*)?\s*:",
    flags=re.I,
)


class FiltroStream:
    """Esconde blocos <think>...</think> e <estado>...</estado> (ou cercas/blocos de estado) em tempo real."""

    def __init__(self) -> None:
        self.buf = ""
        self.modo: str | None = None  # None | "think" | "estado"

    def feed(self, s: str) -> str:
        self.buf += s
        out = ""
        while True:
            if self.modo == "think":
                m = re.search(r"</think\s*>", self.buf, flags=re.I)
                if not m:
                    self.buf = self.buf[-12:]
                    return out
                self.buf = self.buf[m.end():]
                self.modo = None
            elif self.modo == "estado":
                m = re.search(r"</(?:estado|status|state)\s*>", self.buf, flags=re.I)
                if not m:
                    self.buf = self.buf[-12:]
                    return out
                self.buf = self.buf[m.end():]
                # Consome cercas de código residuais logo após </estado>
                self.buf = re.sub(r"^\s*```+\s*", "", self.buf)
                self.modo = None
            else:
                m_think = re.search(r"<think\b[^>]*>", self.buf, flags=re.I)
                m_estado = _RE_INICIO_ESTADO_STREAM.search(self.buf)
                escolhido = None
                novo_modo = None
                if m_think and (not m_estado or m_think.start() <= m_estado.start()):
                    escolhido, novo_modo = m_think, "think"
                elif m_estado:
                    escolhido, novo_modo = m_estado, "estado"
                if escolhido is not None:
                    antes = self.buf[:escolhido.start()]
                    if novo_modo == "estado":
                        antes = antes.rstrip()
                    out += antes
                    self.buf = self.buf[escolhido.end():]
                    self.modo = novo_modo
                    continue

                # Segura qualquer sufixo que possa ser início de <think...>, <estado...>, ``` ou Estado Atual:
                guarda = 0
                ult_lt = self.buf.rfind("<")
                if ult_lt >= 0 and ">" not in self.buf[ult_lt:] and (len(self.buf) - ult_lt) <= 14:
                    cand = self.buf[ult_lt + 1:].strip().lower()
                    if any(
                        not cand or t.startswith(cand) or cand.startswith(t)
                        for t in ("think", "estado", "status", "state")
                    ):
                        guarda = max(guarda, len(self.buf) - ult_lt)
                m_bt = re.search(r"`{1,3}\s*$", self.buf)
                if m_bt:
                    guarda = max(guarda, len(m_bt.group(0)))
                m_md = re.search(r"\n+\s*[*#]*\s*([a-zA-Z\s*#:]*)$", self.buf)
                if m_md and len(m_md.group(0)) <= 28:
                    limpo_md = re.sub(r"[\s*#]+", " ", m_md.group(1)).strip().lower()
                    if not limpo_md or "estado atual:".startswith(limpo_md) or "estado:".startswith(limpo_md):
                        guarda = max(guarda, len(m_md.group(0)))

                corte = len(self.buf) - guarda
                out += self.buf[:corte]
                self.buf = self.buf[corte:]
                return out

    def flush(self) -> str:
        out = "" if self.modo in ("think", "estado") else self.buf
        self.buf = ""
        self.modo = None
        return out


# Compatibilidade com nome antigo
FiltroThink = FiltroStream

_FECHAMENTOS_CLICHE = re.compile(
    r"(?:\s*\n+|\s+)"
    r"(?:o que voc[êe] (?:gostaria de fazer|faz|far[áa]|decide fazer|pretende fazer|vai fazer|diz|responde)"
    r"(?: a seguir| agora| diante disso)?\s*\??"
    r"|como voc[êe] (?:responde|reage|age)(?: a isso)?\s*\??"
    r"|qual (?:[ée] )?a sua (?:pr[óo]xima )?(?:a[çc][ãa]o|escolha|decis[ãa]o|resposta)\s*\??"
    r"|a decis[ãa]o [ée] sua\.?"
    r"|a escolha [ée] sua\.?)\s*$",
    flags=re.I,
)


def limpar_narracao(texto: str) -> str:
    texto = re.sub(r"<think\b[^>]*>.*?</think\s*>", "", texto, flags=re.S | re.I)
    texto = re.sub(r"^.*?</think\s*>", "", texto, flags=re.S | re.I)
    texto = re.sub(r"<think\b[^>]*>.*$", "", texto, flags=re.S | re.I)
    texto = re.sub(r"<(?:estado|status|state)\b[^>]*>.*$", "", texto, flags=re.S | re.I)
    texto = re.sub(r"```+(?:json|xml)?\s*$", "", texto, flags=re.I)
    texto = re.sub(r"```+.*$", "", texto, flags=re.S)
    texto = re.sub(r"\n\s*(?:\*\*|#+)?\s*Estado\s+Atual\s*(?:\*\*)?\s*:.*$", "", texto, flags=re.S | re.I)
    texto = re.sub(
        r"^\s*(?:(?:certamente|claro|aqui est[áa](?: a continua[çc][ãa]o(?: da cena)?)?)[!,:.\s]*)+",
        "",
        texto.strip(),
        flags=re.I,
    )
    texto = re.sub(r"^\s*(Narrador|Narração)\s*:\s*", "", texto.strip(), flags=re.I)
    while True:
        novo = _FECHAMENTOS_CLICHE.sub("", texto.strip()).strip()
        if novo == texto.strip():
            break
        texto = novo
    return texto.strip()


_CHAVES_ESTADO = {"humor", "intencao", "relacao", "bram", "npc", "npcs", "fato", "memoria", "tarefa"}


def _extrair_json(texto: str) -> dict[str, Any]:
    t = re.sub(r"<think\b[^>]*>.*?</think\s*>", "", texto, flags=re.S | re.I).strip()
    t = re.sub(r"^```+(?:json|xml)?\s*|\s*```+$", "", t, flags=re.I).strip()
    dec = json.JSONDecoder()
    pos = 0
    while True:
        i = t.find("{", pos)
        if i < 0:
            break
        trecho = t[i:]
        sem_virgula = re.sub(r",\s*([}\]])", r"\1", trecho)
        base_trunc = trecho.rstrip().rstrip(",")
        cortes = [sem_virgula, base_trunc]
        ult_virg = base_trunc.rfind(",")
        if ult_virg > 0:
            cortes.append(base_trunc[:ult_virg].rstrip())
        for base_cand in cortes:
            for sufixo in ("", "}", "}}", '"}', '"}}', "0.0}}", '""}'):
                try:
                    val, _ = dec.raw_decode(base_cand + sufixo)
                    if isinstance(val, dict) and (_CHAVES_ESTADO & set(val.keys())):
                        return val
                except ValueError:
                    pass
        pos = i + 1
    raise ValueError("JSON de estado inválido")


def _extrair_nome_jogador(texto_jogador: str) -> str:
    m = re.search(
        r"\b(?:meu nome (?:[ée]|\ufffd)|me chamo|pode me chamar de|sou o|sou a)\s+([A-ZÀ-Úa-zà-ú]{2,20})\b",
        texto_jogador,
        flags=re.I,
    )
    if not m:
        return ""
    cand = m.group(1).strip()
    if normalizar(cand) in _NOMES_IGNORADOS:
        return ""
    return cand.capitalize()


def inferir_estado_fallback(texto_jogador: str, narracao: str) -> dict[str, Any]:
    """Fallback leve e determinístico caso o modelo omita ou trunque a tag <estado>."""
    low = normalizar(texto_jogador)
    nome = _extrair_nome_jogador(texto_jogador)
    hostil = any(p in low for p in ("idiota", "chata", "cala a boca", "feia", "sai daqui", "ameac", "ataco", "empurro"))
    silencio = any(p in low for p in ("ignoro", "fico quieto", "nao digo nada", "passo reto", "apenas olho"))
    entregou_lenha = any(p in low for p in ("lenha", "feixe")) and any(p in low for p in ("entrego", "balcao", "bram", "picada"))
    amigavel = any(p in low for p in (
        "oi", "ola", "prazer", "bom dia", "boa noite", "boa tarde", "ajuda", "obrigad",
        "sento", "encosto", "sorrio", "meu nome", "chamo", "ensopado", "caneco", "trabalho",
    ))
    fala_bram = any(p in low for p in ("bram", "taverneiro", "estalagem", "ensopado", "caneco", "cobre", "quarto", "bico"))

    fato_padrao = f"Apresentou-se como {nome}." if nome else ""

    if entregou_lenha:
        return {
            "humor": "impressionada e com sorriso de canto",
            "intencao": "compartilhar uma caneca e puxar conversa sobre a origem do forasteiro",
            "relacao": {"proximidade": 0.05, "confianca": 0.05, "tensao": -0.02},
            "bram": "satisfeito com a lenha entregue, servindo uma tigela fumegante de ensopado no balcão",
            "fato": "Entregou a lenha picada no balcão para Bram e garantiu a tigela de ensopado quente.",
            "tarefa": "ensopado garantido com Bram (lenha entregue)",
        }
    if hostil:
        return {
            "humor": "fechada e em alerta",
            "intencao": "manter distância e avaliar se o forasteiro vai criar confusão no salão",
            "relacao": {"proximidade": -0.03, "confianca": -0.03, "tensao": 0.04},
            "bram": "sério atrás do balcão, pronto para cortar qualquer briga na taverna",
            "fato": fato_padrao,
        }
    if silencio:
        return {
            "humor": "observadora e paciente",
            "intencao": "continuar revisando os mapas enquanto observa o que o forasteiro decide fazer",
            "relacao": {"proximidade": 0.0, "confianca": 0.0, "tensao": 0.0},
            "bram": "cuidando dos canecos no balcão sem forçar conversa",
            "fato": fato_padrao,
        }
    return {
        "humor": "curiosa e irônica" if not amigavel else "atenta e levemente receptiva",
        "intencao": "acompanhar a conversa no balcão e testar a história do forasteiro",
        "relacao": {
            "proximidade": 0.02 if amigavel else 0.01,
            "confianca": 0.01 if amigavel else 0.0,
            "tensao": 0.0,
        },
        "bram": (
            "conversando no balcão enquanto avalia o recém-chegado"
            if fala_bram else "atento atrás do balcão da Lanterna Torta"
        ),
        "fato": fato_padrao,
    }


def _extrair_estado_markdown(bloco_md: str) -> dict[str, Any]:
    """Extrai campos caso um modelo pequeno tenha escrito Estado Atual em markdown."""
    out: dict[str, Any] = {}
    for ln in bloco_md.splitlines():
        s = re.sub(r"[*_`#>-]", "", ln).strip()
        m = re.match(r"^(humor|inten[çc][ãa]o|bram|fato|mem[óo]ria)\s*:\s*(.+)$", s, flags=re.I)
        if not m:
            continue
        chave = normalizar(m.group(1))
        val = m.group(2).strip().rstrip(".")
        if chave == "humor":
            out["humor"] = val
        elif chave.startswith("intenc"):
            out["intencao"] = val
        elif chave == "bram":
            out["bram"] = val
        elif chave in ("fato", "memoria"):
            out["fato"] = limpar_fato(val)
    return out


def extrair_narracao_e_estado(bruto: str, texto_jogador: str) -> tuple[str, dict[str, Any]]:
    """Separa a narração limpa e o dicionário de estado a partir da saída única do LLM."""
    sem_think = re.sub(r"<think\b[^>]*>.*?</think\s*>", "", bruto, flags=re.S | re.I)
    sem_think = re.sub(r"^.*?</think\s*>", "", sem_think, flags=re.S | re.I)
    sem_think = re.sub(r"<think\b[^>]*>.*$", "", sem_think, flags=re.S | re.I)

    estado_bruto = ""
    m = re.search(r"<(?:estado|status|state)\b[^>]*>(.*?)(?:</(?:estado|status|state)\s*>|$)", sem_think, flags=re.S | re.I)
    if m:
        estado_bruto = m.group(1).strip()
        sem_think = sem_think[:m.start()].rstrip()
    else:
        m_json = re.search(
            r"(?:```+(?:json|xml)?\s*)?(\{[^{}]*\"(?:humor|relacao|intencao)\".*)\s*$",
            sem_think,
            flags=re.S | re.I,
        )
        if m_json:
            estado_bruto = m_json.group(1).strip()
            sem_think = sem_think[:m_json.start()].rstrip()

    md_extra: dict[str, Any] = {}
    m_md = re.search(r"\n\s*(?:\*\*|#+)?\s*Estado\s+Atual\s*(?:\*\*)?\s*:(.*)$", sem_think, flags=re.S | re.I)
    if m_md:
        md_extra = _extrair_estado_markdown(m_md.group(1))
        sem_think = sem_think[:m_md.start()].rstrip()

    narracao = limpar_narracao(sem_think)
    base = inferir_estado_fallback(texto_jogador, narracao)
    if md_extra:
        base.update({k: v for k, v in md_extra.items() if v})
    if estado_bruto:
        try:
            parsed = _extrair_json(estado_bruto)
            for k, v in parsed.items():
                if v is None:
                    continue
                if k in ("fato", "memoria"):
                    f_limpo = limpar_fato(v)
                    if f_limpo:
                        base["fato"] = f_limpo
                else:
                    base[k] = v
            if not isinstance(base.get("relacao"), dict):
                base["relacao"] = {"proximidade": 0.0, "confianca": 0.0, "tensao": 0.0}
            return narracao, base
        except ValueError:
            pass
    return narracao, base


# ---------------------------------------------------------------------------
# roteamento de modelo por turno (agy): leve por padrão, médio só quando a conversa pede raciocínio
#
# Regras (texto normalizado: minúsculo, sem acento, pontuação vira espaço; termos casam por prefixo de palavra):
#   1. Enigma das Ruínas: termo rúnico (runa, rúnico, inscrição, glifo, símbolo, marco antigo...) E (o jogador está
#      nas Ruínas do Marco Antigo — cena.local ou cena.marco — OU pede para decifrar/traduzir/entender o significado).
#      Nas Ruínas, pedir para decifrar/resolver basta mesmo sem termo rúnico. "Runa" de passagem fora das Ruínas e
#      sem pedido de decifrar (ex.: "comprei um amuleto com uma runa bonita") fica no leve.
#   2. Dedução: marcador forte ("como se liga", "tem a ver com", "pista", "deduzir"...); OU pergunta que cita 2+
#      missões ativas diferentes (termos exclusivos de cada missão: título, itens, alvo); OU marcador fraco
#      ("por que", "será que") junto de 1+ missão citada ou termo rúnico. "Será que vai chover?" fica no leve.
#   3. Mensagem longa/complexa: >= LIMIAR_CARACTERES_LONGA caracteres, ou >= LIMIAR_FRASES_LONGA frases, ou
#      >= LIMIAR_PERGUNTAS_LONGA perguntas.
#   Caso contrário: MODELO_PADRAO/EFFORT_PADRAO.
# Override: modelo ou esforço forçado (--modelo, --effort, ROLEPLAY_GEMINI_MODEL/EFFORT, Modelo no config.ini
# diferente do padrão) desliga o roteamento — vale sempre o que o usuário pediu (ver roteamento_ativo).

LIMIAR_CARACTERES_LONGA = 420
LIMIAR_FRASES_LONGA = 6
LIMIAR_PERGUNTAS_LONGA = 3
MARCOS_ENIGMA = frozenset({"RuinasMarco"})
LOCAIS_ENIGMA = ("ruinas do marco",)
TERMOS_RUNICOS = ("runa", "runic", "inscri", "glifo", "simbolo", "marco antigo", "primeiro marco", "monolito")
PEDIDOS_ENIGMA = ("enigma", "charada", "decifr", "traduz", "signific", "interpret", "o que diz", "o que dizem",
                  "o que quer dizer", "resolv", "ordem certa", "sequencia")
MARCADORES_DEDUCAO = ("como se liga", "se liga ao ", "se liga a ", "se liga com ", "se ligam", "se conecta", "qual a ligacao", "qual a relacao", "o que tem a ver", "tem a ver com",
                      "pista", "deduz", "deduc", "juntando as", "coincidencia")
MARCADORES_DEDUCAO_FRACOS = ("por que", "porque sera", "sera que")
_INTERROGATIVOS = ("como ", "por que", "qual ", "quais ", "quem ", "onde ", "quando ", "o que ", "sera que", "quanto")
_RE_FRASES = re.compile(r"[^.!?…]*\w[^.!?…]*")


@dataclass(frozen=True)
class ContextoRoteamento:
    local: str = ""
    marco: str = ""
    # termos por missão ativa (jogo.EstadoJogo.pistas_roteamento); termos repetidos entre missões são ignorados
    pistas: tuple[tuple[str, ...], ...] = ()


@dataclass(frozen=True)
class EscolhaModelo:
    model_id: str
    effort: str
    motivo: str


def _tem_termo(texto_norm: str, termos: tuple[str, ...] | frozenset[str]) -> bool:
    return any(re.search(rf"(?<!\w){re.escape(t)}", texto_norm) for t in termos)


def missoes_citadas(texto_norm: str, pistas: tuple[tuple[str, ...], ...]) -> int:
    """Quantas missões ativas diferentes o texto cita, contando só termos exclusivos de cada uma."""
    contagem: dict[str, int] = {}
    for termos in pistas:
        for t in set(termos):
            contagem[t] = contagem.get(t, 0) + 1
    return sum(1 for termos in pistas if _tem_termo(texto_norm, tuple(t for t in termos if contagem[t] == 1)))


def _profundo(motivo: str) -> EscolhaModelo:
    return EscolhaModelo(MODELO_PROFUNDO, EFFORT_PROFUNDO, motivo)


def escolher_modelo(texto: str, contexto: ContextoRoteamento | None = None) -> EscolhaModelo:
    """Função pura: qual modelo do agy atende este turno (ver as regras acima)."""
    ctx = contexto or ContextoRoteamento()
    t = normalizar(texto) + " "  # espaço final: termos terminados em espaço casam palavra inteira
    nas_ruinas = ctx.marco in MARCOS_ENIGMA or any(l in normalizar(ctx.local) for l in LOCAIS_ENIGMA)
    runico = _tem_termo(t, TERMOS_RUNICOS)
    pedido_enigma = _tem_termo(t, PEDIDOS_ENIGMA)
    if (runico and (nas_ruinas or pedido_enigma)) or (nas_ruinas and pedido_enigma):
        return _profundo("enigma das ruínas")
    citadas = missoes_citadas(t, ctx.pistas)
    pergunta = "?" in texto or t.startswith(_INTERROGATIVOS)
    if _tem_termo(t, MARCADORES_DEDUCAO):
        return _profundo("dedução")
    if pergunta and citadas >= 2:
        return _profundo(f"dedução com {citadas} missões")
    if _tem_termo(t, MARCADORES_DEDUCAO_FRACOS) and (citadas >= 1 or runico):
        return _profundo("dedução sobre pista")
    frases = len(_RE_FRASES.findall(texto))
    if len(texto.strip()) >= LIMIAR_CARACTERES_LONGA or frases >= LIMIAR_FRASES_LONGA or texto.count("?") >= LIMIAR_PERGUNTAS_LONGA:
        return _profundo("mensagem longa")
    return EscolhaModelo(MODELO_PADRAO, EFFORT_PADRAO, "cotidiano")


def roteamento_ativo(modelo_explicito: str = "", effort_explicito: str = "") -> bool:
    """O roteamento só age quando ninguém forçou modelo ou esforço (CLI, variável de ambiente ou config.ini)."""
    return not (modelo_explicito or effort_explicito
                or os.environ.get("ROLEPLAY_GEMINI_MODEL") or os.environ.get("ROLEPLAY_GEMINI_EFFORT"))


def modelo_do_config(cfg: dict[str, str]) -> str:
    """Modelo do Gemini escrito no config.ini quando difere do padrão (conta como escolha explícita do usuário).
    O roleplay.ps1 grava ali a chave do modelo do LM Studio; essa nunca vai para o agy."""
    modelo = str(cfg.get("Modelo") or "")
    return modelo if modelo.startswith("gemini") and modelo != CONFIG_DEFAULTS["Modelo"] else ""


# ---------------------------------------------------------------------------
# motores (1 única chamada por turno)


class Motor:
    provider_id = ""
    model_id = ""

    def narrar(self, sistema: str, mensagens: list[dict[str, str]],
               on_token: Callable[[str], None]) -> tuple[str, bool]:
        raise NotImplementedError


class MotorLMStudio(Motor):
    provider_id = "lmstudio"

    def __init__(self, model_key: str, temperatura: float, max_tokens: int) -> None:
        self.model_id = f"lmstudio:{model_key}"
        self.temperatura = temperatura
        self.max_tokens = max_tokens

    def _post(self, body: dict[str, Any]):
        req = urllib.request.Request(
            LMSTUDIO_URL,
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json; charset=utf-8"},
        )
        try:
            return urllib.request.urlopen(req, timeout=600)
        except urllib.error.HTTPError as e:
            detalhe = e.read().decode("utf-8", "replace")[:400]
            raise RuntimeError(f"LM Studio HTTP {e.code}: {detalhe}") from e
        except urllib.error.URLError as e:
            raise RuntimeError(f"LM Studio inacessível em {LMSTUDIO_URL}: {e.reason}") from e

    def narrar(self, sistema: str, mensagens: list[dict[str, str]],
               on_token: Callable[[str], None]) -> tuple[str, bool]:
        body = {
            "model": LMS_IDENTIFIER,
            "temperature": self.temperatura,
            "max_tokens": self.max_tokens,
            "stream": True,
            "reasoning_effort": "none",
            "messages": [{"role": "system", "content": sistema}] + mensagens,
        }
        partes: list[str] = []
        filtro = FiltroStream()
        cortou = False
        with self._post(body) as resp:
            for linha in resp:
                linha_str = linha.decode("utf-8", "replace").strip()
                if not linha_str.startswith("data:"):
                    continue
                dado = linha_str[5:].strip()
                if dado == "[DONE]":
                    break
                try:
                    escolha = json.loads(dado)["choices"][0]
                except (ValueError, KeyError, IndexError):
                    continue
                pedaco = (escolha.get("delta") or {}).get("content") or ""
                if escolha.get("finish_reason") == "length":
                    cortou = True
                if pedaco:
                    partes.append(pedaco)
                    visivel = filtro.feed(pedaco)
                    if visivel:
                        on_token(visivel)
        resto = filtro.flush()
        if resto:
            on_token(resto)
        return "".join(partes), cortou


class MotorAgy(Motor):
    """Motor via CLI autenticada `agy` em chamada única (Gemini)."""

    provider_id = "google-cli"
    model_id = MODELO_PADRAO
    effort = EFFORT_PADRAO

    def __init__(self, model_id: str = "", effort: str = "") -> None:
        exe = os.environ.get("ROLEPLAY_GEMINI_CLI") or shutil.which("agy")
        if not exe:
            raise RuntimeError("CLI 'agy' não encontrada no PATH. Certifique-se de ter o agy instalado.")
        self.exe = exe
        self.model_id = model_id or os.environ.get("ROLEPLAY_GEMINI_MODEL", MODELO_PADRAO)
        self.effort = effort or os.environ.get("ROLEPLAY_GEMINI_EFFORT", EFFORT_PADRAO)
        self.timeout_s = float(os.environ.get("ROLEPLAY_CLI_TIMEOUT_S", "180"))

    def narrar(self, sistema: str, mensagens: list[dict[str, str]],
               on_token: Callable[[str], None]) -> tuple[str, bool]:
        conversa = "\n\n".join(
            f"{'JOGADOR' if m['role'] == 'user' else 'NARRADOR'}: {m['content']}"
            for m in mensagens
        )
        prompt = f"{sistema}\n\n# Conversa Recente\n{conversa}\n\nEscreva a resposta agora:"
        argv = [
            self.exe,
            f"-p={prompt[-14000:]}",
            "--model", self.model_id,
            "--effort", self.effort,
            "--disable-slash-commands",
        ]
        flags: dict[str, Any] = {}
        if os.name == "nt":
            creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
            flags["creationflags"] = creation_flags
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= getattr(subprocess, "STARTF_USESHOWWINDOW", 0x00000001)
            startupinfo.wShowWindow = 0  # SW_HIDE
            flags["startupinfo"] = startupinfo
        proc = subprocess.run(
            argv,
            input=None,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=self.timeout_s,
            **flags,
        )
        if proc.returncode != 0:
            detalhe = ((proc.stderr or "") + (proc.stdout or "")).strip()[-400:]
            raise RuntimeError(f"agy saiu com código {proc.returncode}: {detalhe}")
        bruto = (proc.stdout or "").strip()
        if not bruto:
            raise RuntimeError("agy retornou saída vazia.")
        filtro = FiltroStream()
        visivel = filtro.feed(bruto) + filtro.flush()
        if visivel:
            on_token(visivel)
        return bruto, False


class MotorTeste(Motor):
    """Motor determinístico local: exercita streaming em pedaços, FiltroStream, cena na taverna e estado."""

    provider_id = "teste"
    model_id = "roleplay-teste-leve"

    def narrar(self, sistema: str, mensagens: list[dict[str, str]],
               on_token: Callable[[str], None]) -> tuple[str, bool]:
        ultima = mensagens[-1]["content"] if mensagens else ""
        low = normalizar(ultima)
        nome_revelado = _extrair_nome_jogador(ultima)
        eh_isekai = any(p in sistema.lower() for p in ("cinzas de alvor", "vaeloria", "lanterna torta"))

        m_alvo = re.search(r"^INTERLOCUTOR: ([^—\n]+?) —", sistema, flags=re.M)
        alvo = m_alvo.group(1).strip() if m_alvo else ""
        m_evento = re.search(r"^- EVENTO DESTE TURNO: (.+)$", sistema, flags=re.M)
        if alvo and alvo not in ("Luna", "Bram"):
            evento = m_evento.group(1).strip() if m_evento else ""
            detalhe = f" {evento.split('.')[0]}." if evento else ""
            narracao = (
                f"{alvo} ergue os olhos ao ouvir você, terminando o que fazia antes de responder.{detalhe}\n"
                f"— Fala, Desperto — diz {alvo}, num tom direto, medindo você de cima a baixo. "
                "— Se veio atrás de ajuda, eu escuto. Se veio só olhar, olha rápido que hoje o dia tá cheio."
            )
            estado = {"relacao": {"proximidade": 0.0, "confianca": 0.0, "tensao": 0.0},
                      "npc": f"curioso(a) e atento(a) ao forasteiro", "fato": ""}
            bruto = f"{narracao}\n<estado>{json.dumps(estado, ensure_ascii=False)}</estado>"
            filtro = FiltroStream()
            for i in range(0, len(bruto), 18):
                visivel = filtro.feed(bruto[i:i + 18])
                if visivel:
                    on_token(visivel)
            resto = filtro.flush()
            if resto:
                on_token(resto)
            return bruto, False

        if not eh_isekai:
            saudacao = f"— {nome_revelado}, né? " if nome_revelado else "— "
            narracao = (
                "Luna desvia o olhar para você por um instante, medindo sua chegada com um meio sorriso "
                "curto antes de apoiar o cotovelo na borda da mesa.\n"
                f"{saudacao}Chegou bem na hora em que tudo estava começando a ficar movimentado por aqui — "
                "comenta ela, num tom direto e espontâneo."
            )
            estado: dict[str, Any] = {
                "humor": "curiosa e observadora",
                "intencao": "ver como você se adapta ao ambiente e às pessoas ao redor",
                "relacao": {"proximidade": 0.02, "confianca": 0.01, "tensao": 0.0},
                "fato": f"Apresentou-se como {nome_revelado}." if nome_revelado else "",
            }
        elif any(p in low for p in ("idiota", "chata", "cala a boca", "feia", "sai daqui", "ameac", "ataco", "briga")):
            narracao = (
                "Bram para o pano no meio do caneco e apoia a mão pesada sobre o balcão de madeira, "
                "o olhar calmo endurecendo na mesma hora. Ao lado dele, Luna fecha o caderno de couro "
                "sem pressa e recua meio passo, te medindo com frieza.\n"
                "— Baixa o tom, forasteiro — avisa Bram, a voz grave cortando o murmúrio da lareira. "
                "— Na Lanterna Torta entra quem sabe beber e conversar em paz. Se quiser arrumar "
                "confusão, a chuva lá fora é toda sua.\n"
                "— Começou fazendo amigos rápido, hein — completa Luna, num tom seco, cruzando os braços."
            )
            estado = {
                "humor": "fechada e desconfiada",
                "intencao": "manter distância e ver se o forasteiro recua ou é posto pra fora por Bram",
                "relacao": {"proximidade": -0.03, "confianca": -0.03, "tensao": 0.04},
                "bram": "sério e firme no balcão, pronto para impor ordem na taverna",
                "fato": "Causou tensão logo na chegada à Estalagem Lanterna Torta.",
            }
        elif any(p in low for p in ("ignoro", "fico quieto", "nao digo nada", "passo reto", "apenas olho")):
            narracao = (
                "Bram arqueia a sobrancelha marcada pela cicatriz, dá de ombros e volta a secar o "
                "caneco de estanho, deixando uma tigela vazia perto do caldeirão. Na ponta do balcão, "
                "Luna acompanha seus movimentos pelo canto do olho antes de voltar a traçar uma linha "
                "de carvão na borda do mapa.\n"
                "— Mudo ou só tentando entender onde foi parar? — murmura Luna, sem tirar os olhos "
                "do pergaminho, um meio sorriso curto no canto da boca. — Relaxa, o choque de quem "
                "acorda perto do Marco costuma passar depois da primeira tigela quente."
            )
            estado = {
                "humor": "observadora e levemente irônica",
                "intencao": "deixar o forasteiro no próprio tempo enquanto observa a reação dele",
                "relacao": {"proximidade": 0.0, "confianca": 0.0, "tensao": 0.0},
                "bram": "tranquilo no balcão, respeitando o silêncio mas atento",
                "fato": "",
            }
        elif any(p in low for p in ("lenha", "feixe")) and any(p in low for p in ("entrego", "balcao", "bram", "picada")):
            narracao = (
                "Você apoia o feixe pesado de lenha recém-cortada no canto do balcão de carvalho. "
                "Bram corre os olhos pelas toras bem alinhadas, solta um estalo de aprovação com a língua "
                "e enxuga as mãos calejadas no avental de couro.\n"
                "— Fez o serviço direito, forasteiro. Não poupou o lombo — diz o taverneiro, virando-se para o "
                "caldeirão fumegante e enchendo até a borda uma tigela de barro com ensopado espesso de carne e raízes. "
                "Ele empurra a tigela fumegante e uma fatia generosa de pão de centeio na sua frente. — Pega aí. "
                "Enquanto estiver sob meu teto e pagar o que come com suor, não passa fome.\n"
                "Luna ergue o olhar do mapa, descansando o queixo na palma da mão com um meio sorriso intrigado.\n"
                "— Olha só, alguém que realmente cumpre o que promete na primeira hora em Alvor — comenta ela, "
                "deslizando uma caneca de sidra pelo balcão na sua direção. — Senta aí antes que esfrie. Agora me conta: "
                "de onde você veio de verdade?"
            )
            fato = "Entregou a lenha picada no balcão para Bram e garantiu sua tigela de ensopado quente."
            estado = {
                "humor": "impressionada e com sorriso de canto",
                "intencao": "compartilhar uma caneca e descobrir a verdadeira origem do forasteiro",
                "relacao": {"proximidade": 0.05, "confianca": 0.05, "tensao": -0.02},
                "bram": "satisfeito com a lenha entregue, servindo o ensopado quente prometido",
                "fato": fato,
                "tarefa": "ensopado recebido de Bram (lenha entregue)",
            }
        elif any(p in low for p in ("bram", "taverneiro", "ensopado", "comida", "fome", "cobre", "moeda", "quarto", "trabalho", "bico")):
            narracao = (
                "Bram solta um riso curto pelo nariz, joga o pano no ombro e puxa uma tigela de barro "
                "para perto do caldeirão fumegante atrás do balcão.\n"
                "— Pelo menos é direto — diz Bram, servindo uma concha generosa de ensopado de raízes "
                "com carne defumada e empurrando a tigela com um pedaço de pão escuro na sua direção. "
                "— Essa primeira tigela fica na conta da lenha que você vai rachar nos fundos antes "
                "de dormir. Quarto eu não tenho sobrando sem cobre, mas o banco perto da lareira é seco.\n"
                "Ao lado, Luna apoia o cotovelo no balcão e te observa pegar o pão.\n"
                "— Saiu no lucro — comenta ela, divertida. — Da última vez que vi um Desperto chegar "
                "aqui sem um tostão, o Bram fez o cara lavar panela até meia-noite."
            )
            fato = f"Revelou se chamar {nome_revelado} e negociou com Bram na taverna." if nome_revelado else (
                "Negociou uma tigela de ensopado com Bram em troca de ajudar na Lanterna Torta."
            )
            estado = {
                "humor": "divertida e curiosa",
                "intencao": "puxar papo enquanto você come para descobrir o que você viu perto do Marco",
                "relacao": {"proximidade": 0.02, "confianca": 0.02, "tensao": 0.0},
                "bram": "de bom humor seco, simpático à honestidade do forasteiro",
                "fato": fato,
            }
        else:
            saudacao_nome = f"— {nome_revelado}, é? " if nome_revelado else "— "
            narracao = (
                "Luna inclina a cabeça de lado, reparando melhor no tecido da sua roupa e no jeito "
                "como você olha para o salão da Lanterna Torta. Ela prende o lápis de carvão atrás da "
                "orelha e desliza um banco de madeira com a ponta da bota para perto do balcão.\n"
                f"{saudacao_nome}Eu sou a Luna, e aquele mal-encarado fingindo que não está ouvindo "
                "tudo é o Bram — diz ela, num tom leve e irônico. — Você tem a cara exata de quem "
                "acabou de cair perto do Marco da Estrada Velha há meia hora.\n"
                "Bram apoia uma caneca de água fresca no balcão na sua frente sem cobrar nada.\n"
                "— Senta logo antes que pingue água no meu chão inteiro — resmunga o taverneiro, "
                "embora o tom não tenha hostilidade nenhuma."
            )
            fato = f"Apresentou-se como {nome_revelado} para Luna e Bram na Estalagem Lanterna Torta." if nome_revelado else ""
            estado = {
                "humor": "curiosa e receptiva",
                "intencao": "descobrir o que você lembra de quando despertou perto do Marco da Estrada Velha",
                "relacao": {"proximidade": 0.02, "confianca": 0.01, "tensao": 0.0},
                "bram": "acolhedor do jeito seco dele atrás do balcão",
                "fato": fato,
            }

        bruto = f"{narracao}\n<estado>{json.dumps(estado, ensure_ascii=False)}</estado>"
        filtro = FiltroStream()
        # Simula streaming em pequenos pedaços para validar FiltroStream em tempo real
        passo = 18
        for i in range(0, len(bruto), passo):
            pedaco = bruto[i:i + passo]
            visivel = filtro.feed(pedaco)
            if visivel:
                on_token(visivel)
        resto = filtro.flush()
        if resto:
            on_token(resto)
        return bruto, False


# ---------------------------------------------------------------------------
# LM Studio: garantir modelo carregado (mesma convenção do roleplay.ps1)


def lms(*args: str, timeout: int = 300) -> tuple[int, str]:
    flags: dict[str, Any] = {}
    if os.name == "nt":
        creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
        flags["creationflags"] = creation_flags
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= getattr(subprocess, "STARTF_USESHOWWINDOW", 0x00000001)
        startupinfo.wShowWindow = 0  # SW_HIDE
        flags["startupinfo"] = startupinfo
    try:
        p = subprocess.run(
            [str(LMS_EXE), *args],
            input="",
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            **flags,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        return 1, str(e)
    saida = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", p.stdout or "")
    return p.returncode, saida if p.returncode == 0 else saida + (p.stderr or "")


def lms_json(*args: str) -> list[dict[str, Any]]:
    code, saida = lms(*args)
    if code != 0:
        return []
    dec = json.JSONDecoder()
    pos = 0
    while True:
        i = saida.find("[", pos)
        if i < 0:
            return []
        try:
            val, _ = dec.raw_decode(saida[i:])
            if isinstance(val, list):
                return val
        except ValueError:
            pass
        pos = i + 1


def preparar_lmstudio(cfg: dict[str, str]) -> str:
    if not LMS_EXE.is_file():
        raise RuntimeError(f"LM Studio CLI não encontrado em {LMS_EXE}. Use --motor agy ou --motor teste.")
    print("Consultando o LM Studio...")
    carregado = next((m for m in lms_json("ps", "--json") if m.get("identifier") == LMS_IDENTIFIER), None)
    if carregado:
        ctx = int(carregado.get("contextLength") or carregado.get("context_length") or 0)
        if ctx and ctx < CONTEXTO_MINIMO:
            aviso(f"Modelo carregado com contexto {ctx}; recomendado {CONTEXTO_MINIMO}+.")
            if input("Recarregar agora com contexto maior? [s/N] ").strip().lower() in ("s", "sim"):
                carregado = None
    if not carregado:
        modelos = sorted(
            (m for m in lms_json("ls", "--json") if m.get("type") == "llm"),
            key=lambda m: ("abliterated" not in str(m.get("modelKey", "")), m.get("modelKey", "")),
        )
        if not modelos:
            raise RuntimeError("Nenhum modelo LLM instalado no LM Studio.")
        print()
        padrao = next((i for i, m in enumerate(modelos) if m.get("modelKey") == cfg.get("Modelo")), 0)
        for i, m in enumerate(modelos):
            gb = float(m.get("sizeBytes") or 0) / 1024 ** 3
            print(f"{i + 1} - {m.get('displayName') or m['modelKey']}  [{m['modelKey']}, {gb:.1f} GB]")
        escolha = input(f"Modelo para o roleplay [{padrao + 1}]: ").strip()
        idx = int(escolha) - 1 if escolha.isdigit() and 0 < int(escolha) <= len(modelos) else padrao
        chave = str(modelos[idx]["modelKey"])
        contexto = str(max(int(cfg.get("Contexto") or 4096), CONTEXTO_MINIMO))
        if input(
            f"Descarregar TODOS os modelos e carregar {chave} (contexto {contexto}, GPU {cfg['Gpu']})? [S/n] "
        ).strip().lower() in ("n", "nao", "não"):
            raise RuntimeError("Carga cancelada.")
        lms("unload", "--all")
        print(f"Carregando {chave}... (pode levar até 1 minuto)")
        code, saida = lms(
            "load", chave,
            "--context-length", contexto,
            "--gpu", cfg["Gpu"],
            "--identifier", LMS_IDENTIFIER,
            "--yes",
            timeout=600,
        )
        if code != 0:
            raise RuntimeError(f"Carga falhou: {saida.strip()[-400:]}")
        carregado = {"modelKey": chave}
    code, saida = lms("server", "start")
    if code != 0:
        raise RuntimeError(f"Não foi possível iniciar o servidor local: {saida.strip()[-300:]}")
    return str(carregado.get("modelKey") or LMS_IDENTIFIER)


# ---------------------------------------------------------------------------
# exibição de estado e loop principal


def mostrar_estado(cena: Cena, motor: Motor) -> None:
    r = cena.relacao.d
    nome, ritmo = cena.relacao.estagio()
    npcs = r.get("npcs") or {}
    lembrancas = r.get("lembrancas") or []
    print("\n=== Estado do Mundo e Personas ===")
    print(f"Motor: {motor.provider_id} · {motor.model_id} (1 chamada/turno com streaming)")
    print(f"Luna — Humor/postura: {r.get('humor') or 'curiosa e irônica'}")
    print(f"Luna — Intenção atual: {r.get('intencao') or '-'}")
    print(
        f"Relação com a Luna: {nome} "
        f"(proximidade {float(r.get('proximidade', 0.0)):.2f}, "
        f"confiança {float(r.get('confianca', 0.0)):.2f}, "
        f"tensão {float(r.get('tensao', 0.0)):.2f}, "
        f"{int(r.get('turnos', 0))} turnos)"
    )
    print(f"Ritmo: {ritmo}")
    print("NPCs em cena:")
    for npc_nome, npc_status in npcs.items():
        print(f"  - {npc_nome}: {npc_status}")
    print("Lembranças e fatos registrados:")
    for t in lembrancas[-8:] or ["(nenhuma ainda)"]:
        print(f"  - {t}")
    print("==================================")


AJUDA = (
    "Comandos: /estado  /debug  /nota TEXTO  /narrar (repete o último turno que falhou)  "
    "/limpar  /sair"
)


def executar_turno(motor: Motor, cena: Cena, texto: str, debug: bool) -> bool:
    sistema = montar_sistema_narrador(cena)
    mensagens = cena.mensagens_para_llm(texto, 3500)
    if motor.provider_id == "google-cli":
        print("\n(consultando Gemini via agy...)")
    print("\nNarrador: ", end="", flush=True)
    try:
        bruto, cortou = motor.narrar(sistema, mensagens, lambda s: print(s, end="", flush=True))
    except Exception as e:  # noqa: BLE001
        print()
        aviso(f"Narração falhou: {e}. Use /narrar para tentar novamente.")
        return False
    print()
    resposta, estado = extrair_narracao_e_estado(bruto, texto)
    if not resposta:
        aviso("Narração vazia. Use /narrar para tentar novamente.")
        return False
    if cortou:
        aviso("A geração atingiu o limite de tokens e pode estar incompleta.")

    deltas = cena.salvar_turno(texto, resposta, motor.model_id, estado)
    if debug:
        print("--- [debug] estado atualizado ---")
        print(json.dumps(estado, ensure_ascii=False, indent=2))
        print(f"deltas aplicados: {deltas} -> estágio: {cena.relacao.estagio()[0]}")
        print("---------------------------------")
    return True


def jogar(motor: Motor, cena: Cena, debug: bool) -> None:
    pendente: str | None = None

    print(f"\nROLEPLAY ISEKAI · LUNA & MUNDO ABERTO ({motor.model_id})")
    print(f"Cenário: {cena.pasta}")
    print(AJUDA)
    if not cena.historico:
        print("\n" + cena.texto_abertura())

    while True:
        try:
            texto = input("\nVocê: ").replace("\ufeff", "").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not texto:
            continue
        cmd = texto.split(maxsplit=1)[0].lower()
        if cmd == "/sair":
            break
        if cmd in ("/ajuda", "/help"):
            print(AJUDA)
            continue
        if cmd == "/estado":
            mostrar_estado(cena, motor)
            continue
        if cmd == "/debug":
            debug = not debug
            print(f"Debug {'ligado' if debug else 'desligado'}.")
            continue
        if cmd == "/nota":
            nota = texto[5:].strip()
            if nota:
                cena.relacao.adicionar_lembranca(nota)
                cena.relacao.salvar()
                cena.sincronizar_memoria_txt(nota)
                print("Nota adicionada a memoria.txt e às lembranças.")
            continue
        if cmd == "/limpar":
            if input("Apagar só o histórico recente da cena? (memória e relação ficam) [s/N] ").strip().lower() in ("s", "sim"):
                cena.historico = []
                cena.gravar_historicos()
                print("Histórico recente limpo.")
            continue
        if cmd == "/narrar":
            if not pendente:
                print("Nada pendente para narrar.")
                continue
            if executar_turno(motor, cena, pendente, debug):
                pendente = None
            continue
        if texto.startswith("/"):
            print(f"Comando desconhecido. {AJUDA}")
            continue

        if executar_turno(motor, cena, texto, debug):
            pendente = None
        else:
            pendente = texto

    print("Estado e histórico salvos em", cena.dir)


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass
    cfg = ler_config()
    default_motor = cfg.get("Motor", "agy").lower()
    if default_motor not in ("agy", "lmstudio", "teste"):
        default_motor = "agy"
    ap = argparse.ArgumentParser(
        description="RPG de Mundo Aberto Isekai — Sistema leve de Personas + Streaming em 1 chamada"
    )
    ap.add_argument("--motor", choices=("agy", "lmstudio", "teste"), default=default_motor,
                    help=f"motor de inferência: agy (Gemini padrão), lmstudio (local), teste (padrão: {default_motor})")
    ap.add_argument("--modelo", default="", help=f"modelo do Gemini (padrão: {MODELO_PADRAO}) ou do LM Studio")
    ap.add_argument("--effort", choices=("low", "medium", "high"), default="", help="esforço de raciocínio no agy (padrão: low)")
    ap.add_argument("--pasta", default=cfg["Pasta"], help="pasta da história (padrão: a do config.ini)")
    ap.add_argument("--debug", action="store_true", help="mostra a atualização de estado de cada turno")
    args = ap.parse_args(argv)

    pasta = Path(args.pasta)
    pasta = (pasta if pasta.is_absolute() else ROOT / pasta).resolve()
    if pasta.exists() and not pasta.is_dir():
        print(f"ERRO: caminho da história não é uma pasta: {pasta}", file=sys.stderr)
        return 1
    pasta.mkdir(parents=True, exist_ok=True)

    try:
        if args.motor == "agy":
            modelo = args.modelo or modelo_do_config(cfg) or MODELO_PADRAO
            effort = args.effort or EFFORT_PADRAO
            motor: Motor = MotorAgy(model_id=modelo, effort=effort)
            aviso(f"Motor: Gemini via agy ({motor.model_id}, effort={motor.effort}).")
        elif args.motor == "lmstudio":
            modelo_lms = args.modelo or preparar_lmstudio(cfg)
            motor = MotorLMStudio(
                modelo_lms,
                num(cfg["Temperatura"].replace(",", "."), 0.0, 2.0, 0.8),
                int(num(cfg["MaxTokens"], 50, 8000, 700)),
            )
        else:
            motor = MotorTeste()
    except Exception as e:  # noqa: BLE001
        print(f"ERRO: {e}", file=sys.stderr)
        return 1

    jogar(motor, Cena(pasta), args.debug)
    return 0


if __name__ == "__main__":
    sys.exit(main())
