#!/usr/bin/env python3
"""
Fronteira de origem do server.py, contra um processo REAL (cópia temporária da história, motor 'teste').

O servidor roda em 127.0.0.1, mas qualquer página aberta no navegador pode mandar requisições para lá.
O dado que importa é o save: o teste tenta gravá-lo e lê-lo como um site estranho faria, e confere o
resultado no estado (e no relacao.json em disco), não nos cabeçalhos.

- POST "simples" (text/plain, sem preflight) vindo de outra origem: /api/note não pode gravar a lembrança
  e /api/reset não pode apagar o histórico.
- GET /api/state vindo de outra origem não pode ser legível (sem Access-Control-Allow-Origin liberado).
- Host forjado (DNS rebinding: evil.example apontando para 127.0.0.1) é recusado.
- Controle positivo: a mesma nota, mandada pelo próprio jogo (mesma origem, JSON), é gravada.
- Corpo malformado em /api/acao (status como texto) não derruba o servidor.

Execução:
  python test_server_security.py
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

from test_server_live import SOURCE_STORY, LiveServer

FAILS: list[str] = []
EVIL = "https://evil.example"


def check(cond: bool, msg: str) -> None:
    if not cond:
        FAILS.append(msg)


def raw(srv: LiveServer, method: str, path: str, body: bytes | None, headers: dict[str, str]) -> tuple[int, dict[str, str], bytes]:
    req = urllib.request.Request(f"{srv.base}{path}", data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as err:
        return err.code, dict(err.headers), err.read()
    except (ConnectionError, OSError):
        return 0, {}, b""


def lembrancas(srv: LiveServer) -> list[str]:
    return [str(x) for x in srv.get("/api/state")["state"]["lembrancas"]]


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        story = Path(tmp) / "Isekai"
        shutil.copytree(SOURCE_STORY, story)
        with LiveServer(story) as srv:
            same = {"Origin": srv.base, "Content-Type": "application/json"}

            # 1. Escrita cross-site com POST simples (o navegador manda sem preflight)
            marker = "NOTA-PLANTADA-POR-OUTRO-SITE"
            raw(srv, "POST", "/api/note", json.dumps({"note": marker}).encode(), {"Origin": EVIL, "Content-Type": "text/plain"})
            check(marker not in " ".join(lembrancas(srv)), "outro site gravou uma lembrança no save via /api/note")
            disk = (story / "luna" / "relacao.json").read_text(encoding="utf-8") if (story / "luna" / "relacao.json").exists() else ""
            check(marker not in disk, "a lembrança plantada chegou ao relacao.json em disco")

            # 2. Mesmo com JSON (preflight), a origem estranha não pode escrever
            marker2 = "NOTA-JSON-DE-OUTRO-SITE"
            raw(srv, "POST", "/api/note", json.dumps({"note": marker2}).encode(), {"Origin": EVIL, "Content-Type": "application/json"})
            check(marker2 not in " ".join(lembrancas(srv)), "outro site gravou lembrança com Content-Type JSON")

            # 3. Leitura cross-site do estado (histórico do roleplay)
            status, headers, _ = raw(srv, "GET", "/api/state", None, {"Origin": EVIL})
            acao = headers.get("Access-Control-Allow-Origin")
            check(status == 403 or acao not in ("*", EVIL), f"outro site consegue ler /api/state (status {status}, ACAO {acao!r})")

            # 4. DNS rebinding: Host forjado
            status, _, _ = raw(srv, "GET", "/api/state", None, {"Host": f"evil.example:{srv.port}"})
            check(status == 403, f"Host forjado aceito em /api/state (status {status})")

            # 5. Controle positivo: o próprio jogo grava a nota
            legit = "NOTA-LEGITIMA-DO-JOGO"
            status, _, _ = raw(srv, "POST", "/api/note", json.dumps({"note": legit}).encode(), same)
            check(status == 200 and legit in " ".join(lembrancas(srv)), f"o próprio jogo não conseguiu gravar a nota (status {status})")
            status, _, _ = raw(srv, "POST", "/api/note", json.dumps({"note": "sem origem"}).encode(), {"Content-Type": "application/json"})
            check(status == 200, f"cliente sem Origin (scripts locais, testes) foi recusado (status {status})")

            # 6. Reset cross-site não apaga o histórico
            before = len(srv.get("/api/state")["history"])
            raw(srv, "POST", "/api/reset", json.dumps({"full": True}).encode(), {"Origin": EVIL, "Content-Type": "text/plain"})
            check(legit in " ".join(lembrancas(srv)), "outro site disparou /api/reset completo e apagou as lembranças")
            check(len(srv.get("/api/state")["history"]) == before, "outro site alterou o histórico via /api/reset")

            # 7. Corpo malformado não derruba o servidor
            status, _, _ = raw(srv, "POST", "/api/acao", json.dumps({"acao": "sincronizar_status", "status": "vigor"}).encode(), same)
            check(status in (200, 400), f"status malformado gerou {status}")
            status, _, _ = raw(srv, "POST", "/api/acao", b"{}", {**same, "Content-Length": "abc"})
            check(status == 400, f"Content-Length inválido derrubou a requisição sem resposta (status {status})")
            check(srv.get("/api/health")["ok"], "servidor caiu após corpo malformado")

    if FAILS:
        print("FALHOU:")
        for f in FAILS:
            print("  -", f)
        return 1
    print("OK: escrita, leitura e reset de outra origem recusados; Host forjado recusado; jogo legítimo grava normalmente")
    return 0


if __name__ == "__main__":
    sys.exit(main())
