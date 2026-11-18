#!/usr/bin/env python3
"""
O save sobrevive a uma gravação interrompida.

relacao.json guarda todo o progresso (cobre, bolsa, missões, relação). Simula-se a queda no meio de
uma gravação (a escrita grava metade dos bytes e o processo "morre") e então o jogo é carregado de novo
pelo caminho real (play.Relacao + jogo.EstadoJogo). A pergunta que só o dado sobrevivente responde:
quanto cobre o jogador tem?

- Com gravação atômica, o arquivo antigo continua inteiro e o cobre volta.
- Um save ilegível (corrompido por fora) não é sobrescrito em silêncio: vira relacao.corrompido-*.json.
- Controle negativo: a mesma queda com a escrita direta antiga (write_text) perde o cobre.

Execução:
  python test_save_atomico.py
"""
from __future__ import annotations

import builtins
import json
import sys
import tempfile
from pathlib import Path

import jogo
import play

FAILS: list[str] = []
COBRE = 4321


def check(cond: bool, msg: str) -> None:
    if not cond:
        FAILS.append(msg)


class Crash(RuntimeError):
    pass


def load_cobre(path: Path) -> int:
    rel = play.Relacao(path)
    estado = jogo.EstadoJogo(rel, "", jogo.carregar_dados())
    return estado.cobre


def seed(path: Path) -> None:
    rel = play.Relacao(path)
    estado = jogo.EstadoJogo(rel, "", jogo.carregar_dados())
    estado.d["cobre"] = COBRE
    rel.salvar()
    check(load_cobre(path) == COBRE, "pré-condição: o save semeado não guardou o cobre")


def crash_during(fn) -> None:
    """Executa fn com toda escrita de arquivo de texto gravando só metade e então falhando."""
    real_open = builtins.open
    real_write_text = Path.write_text

    def half_open(file, mode="r", *args, **kwargs):
        f = real_open(file, mode, *args, **kwargs)
        if "w" in mode:
            orig_write = f.write

            def write(s):
                orig_write(s[: len(s) // 2])
                f.flush()
                raise Crash("queda no meio da gravação")

            f.write = write
        return f

    def half_write_text(self, data, *args, **kwargs):
        with half_open(self, "w", encoding=kwargs.get("encoding", "utf-8")) as f:
            f.write(data)

    builtins.open = half_open
    Path.write_text = half_write_text
    try:
        fn()
    except Crash:
        pass
    finally:
        builtins.open = real_open
        Path.write_text = real_write_text


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        # 1. Queda durante a gravação com o código atual
        path = Path(tmp) / "a" / "relacao.json"
        path.parent.mkdir()
        seed(path)
        rel = play.Relacao(path)
        rel.d["turnos"] = 99
        crash_during(rel.salvar)
        check(load_cobre(path) == COBRE, f"queda no meio da gravação perdeu o progresso (cobre {load_cobre(path)} != {COBRE})")

        # 2. Save ilegível não é sobrescrito em silêncio
        path2 = Path(tmp) / "b" / "relacao.json"
        path2.parent.mkdir()
        seed(path2)
        conteudo = path2.read_text(encoding="utf-8")
        path2.write_text(conteudo[: len(conteudo) // 2], encoding="utf-8")
        load_cobre(path2)
        copias = list(path2.parent.glob("relacao.corrompido-*.json"))
        check(len(copias) == 1 and copias[0].read_text(encoding="utf-8") == conteudo[: len(conteudo) // 2],
              f"save ilegível foi sobrescrito sem cópia (cópias: {[c.name for c in copias]})")

        # 3. Controle negativo: escrita direta (comportamento antigo) perde o cobre na mesma queda
        path3 = Path(tmp) / "c" / "relacao.json"
        path3.parent.mkdir()
        seed(path3)
        rel3 = play.Relacao(path3)
        crash_during(lambda: path3.write_text(json.dumps(rel3.d, ensure_ascii=False, indent=2), encoding="utf-8"))
        check(load_cobre(path3) != COBRE, "controle negativo: a escrita direta também sobreviveu à queda (o teste não detecta nada)")

    if FAILS:
        print("FALHOU:")
        for f in FAILS:
            print("  -", f)
        return 1
    print("OK: o save sobrevive à queda no meio da gravação; save ilegível é preservado; escrita direta perderia o progresso")
    return 0


if __name__ == "__main__":
    sys.exit(main())
