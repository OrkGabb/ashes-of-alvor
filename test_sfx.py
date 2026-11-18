#!/usr/bin/env python3
"""
Testes dos efeitos sonoros (public/data/sfx.json + public/audio/sfx/).

- Todo som citado por fx, cues, passos, leitos, emissores e pontuais existe em "sons".
- Cada arquivo publicado decodifica, tem a duração pedida e chega ao alvo de loudness (loops e
  avulsos), salvo quando o pico limitou o ganho. Um arquivo praticamente mudo (o primeiro amb_noite
  saiu a -64 LUFS) reprova aqui; o controle negativo gera um silêncio e exige que ele reprove.
- Loops emendam sem degrau: a diferença entre a última e a primeira amostra fica abaixo de 0,1.
- Gravações de passos rendem pelo menos 4 recortes pelo mesmo detector de ataques do sfx.js.

Uso: python test_sfx.py   (precisa do ffmpeg no PATH e de numpy)
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent / "tools"))
import gen_sfx  # noqa: E402

ROOT = Path(__file__).resolve().parent
MANIFEST = json.loads((ROOT / "public" / "data" / "sfx.json").read_text(encoding="utf-8"))
SONS = MANIFEST["sons"]
GEN = MANIFEST["gerador"]
OUT = ROOT / "public" / "audio" / "sfx"
FAILS: list[str] = []


def check(cond: bool, msg: str) -> None:
    if not cond:
        FAILS.append(msg)


def pcm(path: Path) -> np.ndarray:
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-f", "f32le", "-ac", "1", "-ar", "44100", "-"],
        capture_output=True, check=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32)


def onsets(x: np.ndarray) -> int:
    """Mesmo algoritmo de detectSlices() em public/js/sfx.js."""
    win = 220
    env = np.array([np.mean(np.abs(x[i:i + win])) for i in range(0, len(x) - win, win)])
    th = env.max() * 0.3
    count, last = 0, -36
    for i in range(1, len(env)):
        if env[i] >= th and env[i - 1] < th and i - last >= 36:
            count += 1
            last = i
    return count


def loudness_ok(path: Path, spec: dict) -> tuple[bool, str]:
    lufs, peak = gen_sfx.measure(path)
    target = GEN["lufsLoop"] if spec.get("loop") else GEN["lufsAvulso"]
    limited = peak >= GEN["picoMax"] - 1.5
    ok = abs(lufs - target) <= 2.0 or (limited and lufs < target and lufs > target - 18)
    return ok, f"{lufs:.1f} LUFS (alvo {target}), pico {peak:.1f}"


def test_references() -> None:
    refs = set(MANIFEST["fx"].values()) | set(MANIFEST["cues"].values())
    refs |= {v for k, v in MANIFEST["passos"].items() if k.startswith(("pedra", "terra", "madeira"))}
    refs |= {b["som"] for b in MANIFEST["leitos"]} | {e["som"] for e in MANIFEST["emissores"]}
    for p in MANIFEST["pontuais"]:
        refs |= set(p["sons"])
    missing = refs - set(SONS)
    check(not missing, f"sons citados sem entrada em 'sons': {sorted(missing)}")


def test_files() -> None:
    for base, spec in SONS.items():
        for sid in gen_sfx.variant_names(base, spec):
            check_file(sid, spec)


def check_file(sid: str, spec: dict) -> None:
    path = OUT / f"{sid}.mp3"
    if not path.exists():
        FAILS.append(f"{sid}: arquivo publicado ausente")
        return
    x = pcm(path)
    dur = len(x) / 44100
    check(abs(dur - float(spec["dur"])) < 0.15, f"{sid}: duração {dur:.2f}s, pedido {spec['dur']}s")
    ok, info = loudness_ok(path, spec)
    check(ok, f"{sid}: loudness fora do alvo: {info}")
    if spec.get("loop"):
        jump = abs(float(x[-1]) - float(x[0]))
        check(jump < 0.1, f"{sid}: emenda do loop com degrau de {jump:.3f}")
    if spec.get("cortes") == "auto":
        n = onsets(x)
        check(n >= 4, f"{sid}: só {n} passos detectáveis")


def test_negative_control() -> None:
    """Um arquivo quase mudo precisa reprovar no mesmo critério de loudness."""
    with tempfile.TemporaryDirectory() as tmp:
        quiet = Path(tmp) / "mudo.mp3"
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "anoisesrc=a=0.0005:d=4", "-c:a", "libmp3lame", str(quiet)],
            check=True,
        )
        ok, info = loudness_ok(quiet, {"loop": True})
        check(not ok, f"controle negativo: arquivo mudo passou no critério ({info})")


def main() -> int:
    test_references()
    test_files()
    test_negative_control()
    if FAILS:
        print("FALHOU:")
        for f in FAILS:
            print("  -", f)
        return 1
    print(f"OK: {len(SONS)} sons ({sum(int(v.get('variantes', 1)) for v in SONS.values())} arquivos), referências, loudness, emendas e passos conferidos (+ controle negativo)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
