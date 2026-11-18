#!/usr/bin/env python3
"""
Roteamento de modelo por turno (play.escolher_modelo) e o caminho real do chat (/api/chat -> streaming_agy).

1. Função pura: conversa cotidiana -> gemini-4-hydrogen-low; enigma/runas nas Ruínas do Marco Antigo, dedução
   cruzando pistas de missões ativas e mensagem longa -> gemini-4-hydrogen-medium (effort medium).
   Controles negativos documentados: "runa" de passagem fora das Ruínas e sem pedido de decifrar fica no leve;
   duas missões citadas SEM pergunta ficam no leve; "será que vai chover?" fica no leve.
2. Handler HTTP real (servidor em processo, cópia temporária da história) com um MotorAgy de verdade apontando
   para um executável dublê: subprocess.Popen é substituído por um dublê que CAPTURA o argv e devolve uma resposta
   pronta — a CLI real nunca é chamada. O argv precisa trazer o modelo/esforço escolhidos, a resposta SSE e o log
   da sessão precisam registrar o modelo usado, e o motor compartilhado não pode ser alterado.
   Controle negativo: o mesmo enigma com o streaming ignorando a escolha (comportamento antigo) sai no modelo leve.
3. Override: com --modelo/--effort forçado (ou ROLEPLAY_GEMINI_MODEL/EFFORT), o roteamento desliga.

Execução:
  python test_roteamento.py
"""
from __future__ import annotations

import copy
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.request
from pathlib import Path
from typing import Any

import jogo
import play
import server
from test_combate import SAVE_V2_PRE_COMBATE, carregar
from test_server_live import SOURCE_STORY

FAILS: list[str] = []
LOW, MEDIUM = play.MODELO_PADRAO, play.MODELO_PROFUNDO
LOCAL_RUINAS = "Ruínas do Marco Antigo (Santuário Ancestral · Câmara Selada)"
ENIGMA = "Luna, essas runas no monólito formam alguma sequência? O que dizem?"


def check(cond: bool, msg: str) -> None:
    print(f"  [{'OK' if cond else 'FALHOU'}] {msg}")
    if not cond:
        FAILS.append(msg)


def pistas_reais(tmp: Path) -> tuple[tuple[str, ...], ...]:
    """Pistas de um EstadoJogo real com a lente do Darian e a patrulha sul em andamento."""
    save = copy.deepcopy(SAVE_V2_PRE_COMBATE)
    save["jogo"]["missoes"]["lente_darian"] = {"estado": "ativa", "etapa": 1}
    save["jogo"]["missoes"]["patrulha_sul"] = {"estado": "ativa", "etapa": 1}
    save["jogo"]["missoes"]["caca_javalis"] = {"estado": "ativa", "etapa": 0}
    save["jogo"]["missoes"]["caca_slimes"] = {"estado": "ativa", "etapa": 0}
    return carregar(tmp / "pistas.json", save).pistas_roteamento()


def parte_pura(tmp: Path) -> None:
    print("=== 1. escolher_modelo (função pura) ===")
    pistas = pistas_reais(tmp)
    taverna = play.ContextoRoteamento(local="Estalagem Lanterna Torta (Salão)", pistas=pistas)
    ruinas = play.ContextoRoteamento(local=LOCAL_RUINAS, pistas=pistas)
    ruinas_marco = play.ContextoRoteamento(local="", marco="RuinasMarco", pistas=pistas)
    casos: list[tuple[str, play.ContextoRoteamento, str, str]] = [
        ("Oi, Bram! Me vê um ensopado e uma caneca de sidra?", taverna, LOW, "pedido cotidiano na taverna"),
        ("Bom dia, Rosa. Tem pão de mel hoje?", taverna, LOW, "conversa curta com a padeira"),
        ("[Entrega o feixe de lenha cortada sobre o balcão]", taverna, LOW, "ação de entrega"),
        ("Comprei um amuleto com uma runa bonita na feira, gostou?", taverna, LOW, "CONTROLE: 'runa' de passagem fora das Ruínas fica no leve"),
        ("Será que vai chover hoje?", taverna, LOW, "CONTROLE: 'será que' sem pista fica no leve"),
        ("Peguei a lente do Darian e depois vou fazer a patrulha.", taverna, LOW, "CONTROLE: duas missões citadas sem pergunta ficam no leve"),
        ("Quero fazer minha inscrição na guilda.", taverna, LOW, "CONTROLE: 'inscrição' de cadastro, sem pedido de decifrar"),
        ("Maren, como vão os contratos de caça?", taverna, LOW, "CONTROLE: termo comum a vários contratos não conta como 2 missões"),
        ("Se liga aqui, Bram, o ensopado tá no ponto!", taverna, LOW, "CONTROLE: gíria 'se liga' não é dedução"),
        (ENIGMA, ruinas, MEDIUM, "enigma das runas nas Ruínas (cena.local)"),
        ("Olha essa inscrição gravada aqui.", ruinas_marco, MEDIUM, "inscrição nas Ruínas (cena.marco = RuinasMarco)"),
        ("Como a gente resolve esse enigma da porta?", ruinas, MEDIUM, "enigma nas Ruínas sem termo rúnico"),
        ("Dá pra decifrar o que essas runas significam?", taverna, MEDIUM, "pedido de decifrar runas fora das Ruínas"),
        ("O que a lente do Darian e a patrulha da estrada têm em comum?", taverna, MEDIUM, "pergunta cruzando 2 missões ativas"),
        ("Os javalis e os slimes apareceram juntos, quem atraiu quem?", taverna, MEDIUM, "pergunta cruzando 2 contratos de caça"),
        ("Como isso se liga ao que o Aldric falou?", taverna, MEDIUM, "marcador de dedução forte ('como se liga')"),
        ("Por que o Darian quer tanto essa lente de volta?", taverna, MEDIUM, "marcador fraco ('por que') + missão citada"),
        (("Luna, preciso te contar tudo o que aconteceu desde ontem. Eu acordei perto do marco sem lembrar de nada. "
          "Depois o Bram me deu trabalho. A Maren me registrou na Guilda. O Aldric me mandou para a estrada. "
          "Lá eu vi rastros estranhos. Agora não sei em quem confiar nem para onde ir."), taverna, MEDIUM, "mensagem longa (frases)"),
        ("a " * 230, taverna, MEDIUM, f"mensagem longa (>= {play.LIMIAR_CARACTERES_LONGA} caracteres)"),
    ]
    for texto, ctx, esperado, desc in casos:
        e = play.escolher_modelo(texto, ctx)
        ok = e.model_id == esperado and e.effort == ("medium" if esperado == MEDIUM else "low")
        check(ok, f"{desc} -> {e.model_id}/{e.effort} ({e.motivo})")
    check(play.escolher_modelo("oi").model_id == LOW, "sem contexto nenhum: leve")


class Captura:
    def __init__(self) -> None:
        self.argvs: list[list[str]] = []

    def popen(self, argv: list[str], **_: Any) -> "ProcDuble":
        self.argvs.append(list(argv))
        return ProcDuble()


class ProcDuble:
    """Processo do agy de mentira: stdout em bytes (read1), stderr vazio, código 0."""

    SAIDA = "*passa o dedo pelas runas* — Isso aqui é uma sequência, não enfeite.\n<estado>{\"humor\": \"concentrada\"}</estado>"

    def __init__(self) -> None:
        self.stdout = io.TextIOWrapper(io.BytesIO(self.SAIDA.encode("utf-8")), encoding="utf-8")
        self.stderr = io.StringIO("")
        self.returncode = 0

    def wait(self, timeout: float | None = None) -> int:
        return 0

    def poll(self) -> int:
        return 0

    def kill(self) -> None:
        return None


def chat(base: str, message: str, npc: str, local: str) -> dict[str, Any]:
    payload = {"message": message, "npc": npc, "cena": {"local": local, "presentes": [{"id": npc, "atividade": "por perto"}]}}
    req = urllib.request.Request(f"{base}/api/chat", data=json.dumps(payload).encode("utf-8"), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read().decode("utf-8")
    frames = [json.loads(b.strip()[5:]) for b in raw.split("\n\n") if b.strip().startswith("data:") and b.strip()[5:].strip() != "[DONE]"]
    return frames[-1]


class ServidorEmProcesso:
    def __init__(self, story: Path, modelo: str = "", effort: str = "") -> None:
        self.httpd = server.criar_servidor(host="127.0.0.1", port=0, pasta_historia=story, motor_nome="agy", modelo=modelo, effort=effort)
        self.app: server.EstadoServidor = self.httpd.app_state  # type: ignore[attr-defined]
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self) -> "ServidorEmProcesso":
        self.thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


def argv_modelo(argv: list[str]) -> tuple[str, str]:
    return argv[argv.index("--model") + 1], argv[argv.index("--effort") + 1]


def parte_handler(tmp: Path) -> None:
    print("=== 2. /api/chat usa o modelo escolhido (MotorAgy real + Popen dublê) ===")
    for k in ("ROLEPLAY_GEMINI_MODEL", "ROLEPLAY_GEMINI_EFFORT"):
        os.environ.pop(k, None)
    os.environ["ROLEPLAY_GEMINI_CLI"] = "agy-duble-nao-executa"
    story = tmp / "Isekai"
    shutil.copytree(SOURCE_STORY, story, ignore=shutil.ignore_patterns("sessao-*.txt", "*.bak"))
    (story / "luna" / "historico.json").write_text("[]", encoding="utf-8")
    cap = Captura()
    popen_real = subprocess.Popen
    subprocess.Popen = cap.popen  # type: ignore[assignment,misc]
    try:
        with ServidorEmProcesso(story) as srv:
            check(isinstance(srv.app.motor, play.MotorAgy) and srv.app.rotear and srv.app.motor.model_id == LOW,
                  "motor agy de verdade, padrão gemini-4-hydrogen-low, roteamento ligado")
            state = json.loads(urllib.request.urlopen(f"{srv.base}/api/state", timeout=10).read())
            check(state["motor"]["model"] == LOW and state["motor"]["routing"] is True, "/api/state informa modelo padrão e roteamento")

            done = chat(srv.base, ENIGMA, "luna", LOCAL_RUINAS)
            modelo, effort = argv_modelo(cap.argvs[-1])
            check((modelo, effort) == (MEDIUM, "medium"), f"enigma nas Ruínas: argv do agy com --model {modelo} --effort {effort}")
            check(done.get("type") == "done" and done["model"] == MEDIUM and done["model_reason"] == "enigma das ruínas",
                  "resposta SSE registra o modelo usado e o motivo")
            log = "".join(p.read_text(encoding="utf-8") for p in (story / "luna").glob("sessao-*.txt"))
            check(MEDIUM in log, "log da sessão registra gemini-4-hydrogen-medium")
            check(srv.app.motor.model_id == LOW and srv.app.motor.effort == "low", "o motor compartilhado não foi alterado")

            done = chat(srv.base, "Bram, me vê uma caneca de sidra?", "bram", "Estalagem Lanterna Torta (Salão)")
            check(argv_modelo(cap.argvs[-1]) == (LOW, "low") and done["model"] == LOW, "pedido cotidiano: argv com o modelo leve")

            original = server.streaming_agy
            server.streaming_agy = lambda motor, sistema, msgs, on_token, *_: original(motor, sistema, msgs, on_token)  # type: ignore[assignment]
            try:
                chat(srv.base, ENIGMA, "luna", LOCAL_RUINAS)
            finally:
                server.streaming_agy = original
            check(argv_modelo(cap.argvs[-1]) == (LOW, "low"),
                  "CONTROLE NEGATIVO: com o streaming ignorando a escolha (código antigo), o enigma sai no leve — o teste acima detecta")

        print("=== 3. Override desliga o roteamento ===")
        with ServidorEmProcesso(story, modelo=LOW) as srv:
            chat(srv.base, ENIGMA, "luna", LOCAL_RUINAS)
            check(not srv.app.rotear and argv_modelo(cap.argvs[-1]) == (LOW, "low"), "--modelo gemini-4-hydrogen-low forçado: enigma não sobe de modelo")
        with ServidorEmProcesso(story, effort="high") as srv:
            chat(srv.base, ENIGMA, "luna", LOCAL_RUINAS)
            check(not srv.app.rotear and argv_modelo(cap.argvs[-1]) == (LOW, "high"), "--effort high forçado: vale o pedido do usuário")
        os.environ["ROLEPLAY_GEMINI_MODEL"] = MEDIUM
        try:
            with ServidorEmProcesso(story) as srv:
                chat(srv.base, "Oi, Bram!", "bram", "Estalagem Lanterna Torta (Salão)")
                check(not srv.app.rotear and argv_modelo(cap.argvs[-1])[0] == MEDIUM, "ROLEPLAY_GEMINI_MODEL forçado: usa o da variável sempre")
        finally:
            os.environ.pop("ROLEPLAY_GEMINI_MODEL", None)
        check(play.modelo_do_config({"Modelo": LOW}) == "" and play.modelo_do_config({"Modelo": "gemini-4-hydrogen-high"}) == "gemini-4-hydrogen-high",
              "config.ini com Modelo do Gemini diferente do padrão conta como escolha explícita")
        check(play.modelo_do_config({"Modelo": "qwen3-14b-abliterated"}) == "",
              "chave do LM Studio gravada pelo roleplay.ps1 no config.ini não é passada ao agy")
    finally:
        subprocess.Popen = popen_real  # type: ignore[misc]
        os.environ.pop("ROLEPLAY_GEMINI_CLI", None)


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="alvor_rota_"))
    try:
        parte_pura(tmp)
        parte_handler(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if FAILS:
        print(f"\nFALHOU ({len(FAILS)}):")
        for f in FAILS:
            print("  -", f)
        return 1
    print("\nOK: roteamento low/medium, caminho real do chat com o modelo escolhido e override respeitado")
    return 0


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass
    sys.exit(main())
