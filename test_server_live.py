#!/usr/bin/env python3
"""
Teste de ponta a ponta do loop de missão "Lenha para o Bram" contra um processo REAL do server.py.

- Roda sobre uma CÓPIA temporária de historias/Isekai (nunca toca o save do jogador).
- Usa o motor determinístico 'teste' (sem rede).
- Carrega o dado de verdade: lê relacao.json do disco e reinicia o servidor para provar persistência.
- Controles negativos: entregar sem lenha é recusado (e não libera o ensopado nem mexe na confiança);
  recolher de novo depois da entrega é recusado.

Execução:
  python test_server_live.py
"""
from __future__ import annotations

import json
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOURCE_STORY = ROOT / "historias" / "Isekai"
DELIVERY_TEXT = "[Entrega o feixe de lenha cortada sobre o balcão]"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class LiveServer:
    def __init__(self, story_dir: Path) -> None:
        self.story_dir = story_dir
        self.port = free_port()
        self.proc: subprocess.Popen[bytes] | None = None

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def __enter__(self) -> "LiveServer":
        self.proc = subprocess.Popen(
            [sys.executable, str(ROOT / "server.py"), "--motor", "teste", "--port", str(self.port), "--pasta", str(self.story_dir)],
            cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        deadline = time.time() + 15
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(f"{self.base}/api/health", timeout=1) as r:
                    if json.loads(r.read())["ok"]:
                        return self
            except OSError:
                time.sleep(0.15)
        raise RuntimeError("server.py não respondeu em 15 s")

    def __exit__(self, *_: object) -> None:
        if self.proc is not None:
            self.proc.terminate()
            self.proc.wait(timeout=10)

    def get(self, path: str) -> dict:
        with urllib.request.urlopen(f"{self.base}{path}", timeout=10) as r:
            return json.loads(r.read().decode("utf-8"))

    def post(self, path: str, body: dict) -> dict:
        req = urllib.request.Request(f"{self.base}{path}", data=json.dumps(body).encode("utf-8"), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8"))

    def chat(self, message: str, acao: str = "") -> list[dict]:
        payload = {"message": message, "motor": "teste"}
        if acao:
            payload["acao"] = acao
        req = urllib.request.Request(f"{self.base}/api/chat", data=json.dumps(payload).encode("utf-8"), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read().decode("utf-8")
        frames = []
        for block in raw.split("\n\n"):
            line = block.strip()
            if line.startswith("data:") and line[5:].strip() != "[DONE]":
                frames.append(json.loads(line[5:].strip()))
        return frames


def on_disk(story_dir: Path) -> dict:
    return json.loads((story_dir / "luna" / "relacao.json").read_text(encoding="utf-8"))


def check(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)
    print(f"  [OK] {msg}")


def run() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="alvor_e2e_"))
    story = tmp / "Isekai"
    shutil.copytree(SOURCE_STORY, story, ignore=shutil.ignore_patterns("sessao-*.txt"))
    try:
        with LiveServer(story) as srv:
            print("=== 1. Nova jornada (reinício completo) parte de um estado limpo ===")
            srv.post("/api/reset", {"full": True})
            st = srv.get("/api/state")["state"]
            check(st["missao_lenha"] == "pendente" and st["inventario"]["tem_lenha"] is False, "missão pendente e inventário vazio")
            check(st["ensopado_desbloqueado"] is False, "ensopado bloqueado no início")
            trust0 = st["confianca_bram"]

            print("=== 2. Controle negativo: entregar sem lenha ===")
            frames = srv.chat(DELIVERY_TEXT, acao="entregar_lenha")
            events = [f for f in frames if f.get("type") == "event"]
            check(len(events) == 1 and events[0]["event"] == "entrega_recusada" and events[0]["ok"] is False, "entrega sem item é recusada pelo servidor")
            st = srv.get("/api/state")["state"]
            check(st["ensopado_desbloqueado"] is False and st["confianca_bram"] == trust0, "recusa não libera ensopado nem altera confiança")
            check("lenha entregue" not in json.dumps(on_disk(story)["npcs"], ensure_ascii=False), "narrador não gravou 'lenha entregue' no status de Bram")

            print("=== 3. Recolher o feixe nos fundos ===")
            res = srv.post("/api/acao", {"acao": "recolher_lenha"})
            check(res["ok"] is True and res["state"]["inventario"]["tem_lenha"] is True, "POST /api/acao registra tem_lenha: true")
            check(on_disk(story)["jogo"]["inventario"].get("feixe_lenha") == 1, "feixe de lenha persistido em relacao.json no disco (save v2)")
            res2 = srv.post("/api/acao", {"acao": "recolher_lenha"})
            check(res2["ok"] is False and res2["event"] == "ja_carrega_lenha", "não dá para recolher dois feixes")

        print("=== 4. Reinício do servidor no meio da missão ===")
        with LiveServer(story) as srv:
            st = srv.get("/api/state")["state"]
            check(st["inventario"]["tem_lenha"] is True and st["missao_lenha"] == "coletada", "feixe continua no inventário após reiniciar o processo")

            print("=== 5. Entrega no balcão ===")
            frames = srv.chat(DELIVERY_TEXT, acao="entregar_lenha")
            kinds = [f.get("type") for f in frames]
            check(kinds[0] == "event" and frames[0]["event"] == "lenha_entregue", "primeiro frame SSE é o evento lenha_entregue (antes da narração)")
            check("token" in kinds and kinds[-1] == "done", "narração transmitida em streaming e finalizada")
            done = frames[-1]["state"]
            check(done["inventario"]["tem_lenha"] is False, "feixe saiu do inventário")
            check(done["ensopado_desbloqueado"] is True, "ensopado desbloqueado")
            check(abs(done["confianca_bram"] - (trust0 + 0.25)) < 1e-6, f"confiança de Bram subiu de {trust0:.2f} para {done['confianca_bram']:.2f}")
            check("satisfeito" in done["npcs"]["Bram"], "Bram satisfeito no estado")
            check(done["tarefa"].startswith("Ensopado liberado"), "tarefa derivada da etapa concluída")

            print("=== 6. Controle negativo: recolher de novo após a entrega ===")
            res = srv.post("/api/acao", {"acao": "recolher_lenha"})
            check(res["ok"] is False and res["event"] == "missao_concluida", "missão concluída não pode ser repetida")

        print("=== 7. Persistência após novo reinício (lendo o disco e o servidor) ===")
        disk = on_disk(story)
        check(disk["jogo"]["missoes"]["lenha_bram"]["estado"] == "concluida" and disk["jogo"]["desbloqueios"]["ensopado"] is True, "relacao.json no disco: missão concluída e ensopado liberado")
        check(any("feixe de lenha" in m for m in disk["lembrancas"]), "lembrança da entrega gravada")
        with LiveServer(story) as srv:
            st = srv.get("/api/state")["state"]
            check(st["ensopado_desbloqueado"] is True and abs(st["confianca_bram"] - (trust0 + 0.25)) < 1e-6, "estado sobrevive ao reinício do processo")
            print("=== 8. Nova jornada reinicia a missão (com backup da memória) ===")
            srv.post("/api/reset", {"full": True})
            st = srv.get("/api/state")["state"]
            check(st["missao_lenha"] == "pendente" and st["ensopado_desbloqueado"] is False, "missão volta a pendente")
            check(any(p.suffix == ".bak" for p in story.iterdir()), "backup da memória criado")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass
    run()
    print("\n>>> LOOP DE MISSÃO 'LENHA PARA O BRAM' VALIDADO DE PONTA A PONTA <<<")
