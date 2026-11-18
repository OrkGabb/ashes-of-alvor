#!/usr/bin/env python3
"""
Conversas separadas por NPC, contra um processo REAL do server.py (cópia temporária da história, motor 'teste').

- Fala-se com o Bram e depois com a Rosa. O que o modelo recebe para a Rosa (Cena.mensagens_para_llm com o
  save gravado em disco) não contém a fala dita ao Bram, e /api/state devolve as duas conversas separadas.
- Persistência: o servidor é reiniciado e as duas conversas voltam, cada uma no seu NPC.
- Migração: um historico.json no formato antigo (lista única) vira o histórico do narrador geral, sem perder
  mensagens e sem vazar para os NPCs.
- Prompt de conversa: com interlocutor, o sistema pede fala direta e curta (sem a tarefa de narrar 120-220
  palavras em segunda pessoa); sem interlocutor (modo terminal), a narração continua como era.
- Controle negativo: o comportamento antigo (um histórico único para todos) reconstruído aqui vaza a fala do
  Bram para a Rosa.

Execução:
  python test_conversa.py
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
from pathlib import Path

import play
from test_server_live import SOURCE_STORY, LiveServer

FAILS: list[str] = []
FALA_BRAM = "Bram, quanto custa o ensopado de javali hoje?"
FALA_ROSA = "Rosa, ainda tem pão de mel saindo do forno?"


def check(cond: bool, msg: str) -> None:
    if not cond:
        FAILS.append(msg)


def chat(srv: LiveServer, npc: str, text: str) -> None:
    import urllib.request
    body = json.dumps({"message": text, "npc": npc, "motor": "teste",
                       "cena": {"local": "Praça", "hora": "10:00", "clima": "tempo aberto", "presentes": []}}).encode()
    req = urllib.request.Request(f"{srv.base}/api/chat", data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        r.read()


def textos(msgs: list[dict]) -> str:
    return " ".join(m["content"] for m in msgs)


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        story = Path(tmp) / "Isekai"
        shutil.copytree(SOURCE_STORY, story)
        (story / "luna" / "historico.json").unlink(missing_ok=True)
        with LiveServer(story) as srv:
            chat(srv, "bram", FALA_BRAM)
            chat(srv, "rosa", FALA_ROSA)
            st = srv.get("/api/state")
        hist = st.get("histories", {})
        check(FALA_BRAM in textos(hist.get("bram", [])), "a conversa com o Bram não foi guardada no Bram")
        check(FALA_ROSA in textos(hist.get("rosa", [])), "a conversa com a Rosa não foi guardada na Rosa")
        check(FALA_BRAM not in textos(hist.get("rosa", [])), "a fala dita ao Bram aparece na conversa da Rosa (/api/state)")

        # O que o modelo recebe, a partir do save em disco (mesmo caminho do servidor)
        cena = play.Cena(story)
        para_rosa = textos(cena.mensagens_para_llm("E o preço?", 3500, npc="rosa"))
        check(FALA_ROSA in para_rosa, "o modelo não recebe a conversa anterior com a Rosa")
        check(FALA_BRAM not in para_rosa, "o modelo recebe a fala dita ao Bram ao responder pela Rosa")
        para_bram = textos(cena.mensagens_para_llm("E o preço?", 3500, npc="bram"))
        check(FALA_BRAM in para_bram and FALA_ROSA not in para_bram, "a conversa do Bram não está isolada")
        novo = textos(cena.mensagens_para_llm("Olá", 3500, npc="sera"))
        check("Lanterna Torta" not in novo and FALA_BRAM not in novo, "NPC novo recebe cena de abertura ou conversa alheia")

        # Persistência através de um reinício do servidor
        with LiveServer(story) as srv:
            st2 = srv.get("/api/state")
        check(FALA_BRAM in textos(st2["histories"].get("bram", [])) and FALA_ROSA in textos(st2["histories"].get("rosa", [])),
              "as conversas por NPC não sobreviveram ao reinício do servidor")

        # Controle negativo: histórico único (comportamento antigo) vaza o Bram para a Rosa
        antigo = []
        for npc_msgs in (hist.get("bram", []), hist.get("rosa", [])):
            antigo += npc_msgs
        check(FALA_BRAM in textos(antigo[-6:]), "controle negativo: o histórico único antigo não vazaria (o teste não detecta nada)")

        # Migração do formato antigo (lista única)
        story2 = Path(tmp) / "Antiga"
        shutil.copytree(SOURCE_STORY, story2)
        velho = [{"role": "user", "content": "mensagem antiga 1"}, {"role": "assistant", "content": "resposta antiga 1"}]
        (story2 / "luna" / "historico.json").write_text(json.dumps(velho, ensure_ascii=False), encoding="utf-8")
        cena2 = play.Cena(story2)
        check(textos(cena2.historico) == textos(velho), "migração perdeu o histórico antigo do narrador geral")
        check("mensagem antiga 1" not in textos(cena2.mensagens_para_llm("oi", 3500, npc="bram")), "histórico antigo vazou para um NPC")

        # Prompt: conversa direta com NPC; narração em segunda pessoa só no modo terminal
        ctx = {"interlocutor": {"id": "bram", "nome": "Bram", "titulo": "Taverneiro", "persona": "seco", "atividade": ""},
               "presentes": [], "local": "Estalagem", "hora": "10:00", "clima": "chuva"}
        conversa = play.montar_sistema_narrador(cena, ctx)
        terminal = play.montar_sistema_narrador(cena, None)
        check("conversa direta com Bram" in conversa and "120 a 220 palavras" not in conversa, "prompt com NPC ainda pede narração longa")
        check("120 a 220 palavras" in terminal, "modo terminal perdeu a narração em segunda pessoa")

    if FAILS:
        print("FALHOU:")
        for f in FAILS:
            print("  -", f)
        return 1
    print("OK: conversas isoladas por NPC (estado, modelo e reinício), migração do formato antigo e prompt de conversa direta (+ controle negativo)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
