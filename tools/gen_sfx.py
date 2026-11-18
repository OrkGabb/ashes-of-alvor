#!/usr/bin/env python3
"""
Efeitos sonoros via ElevenLabs (Sound Effects API), a partir da fonte única public/data/sfx.json.

Cada entrada de "sons" é gerada uma vez em assets_src/sfx_raw/<id>.mp3 (prompt, duração, loop sem
emenda e prompt_influence vêm do manifesto) e publicada normalizada em public/audio/sfx/<id>.mp3:
ganho linear até o alvo de loudness (loops e avulsos têm alvos diferentes), limitado pelo pico máximo,
para a mixagem no jogo depender só do campo "ganho". Ganho linear não altera a emenda dos loops.
Brutos já existentes não são gerados de novo; o custo estimado é mostrado antes e o script para no
primeiro erro de cota. --normalizar refaz só a etapa de publicação (sem gastar créditos).
"variantes": N gera <id>.mp3, <id>_2.mp3 ... <id>_N.mp3 com o mesmo prompt (cada chamada sai diferente).

A chave fica só no ambiente (ELEVENLABS_API_KEY), nunca no repositório.

Uso:
  python tools/gen_sfx.py --dry-run                 # lista o que falta e o custo estimado
  python tools/gen_sfx.py [--only galo,corvo] [--force] [--max-creditos 8500]
  python tools/gen_sfx.py --normalizar               # republica todos os brutos com os alvos atuais
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "public" / "data" / "sfx.json"
OUT = ROOT / "public" / "audio" / "sfx"
RAW = ROOT / "assets_src" / "sfx_raw"
API = "https://api.elevenlabs.io/v1/sound-generation"


class QuotaError(RuntimeError):
    pass


def load_manifest() -> dict:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def variant_names(sid: str, spec: dict) -> list[str]:
    """Nomes de arquivo (sem extensão) de todas as variantes de um som; o navegador usa a mesma regra."""
    return [sid] + [f"{sid}_{k}" for k in range(2, int(spec.get("variantes", 1)) + 1)]


def cost(spec: dict, per_second: float) -> int:
    return int(round(float(spec["dur"]) * per_second))


def measure(path: Path) -> tuple[float, float]:
    """Loudness integrada (LUFS) e pico verdadeiro (dBTP) pelo filtro ebur128 do ffmpeg."""
    log = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-af", "ebur128=peak=true", "-f", "null", "-"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    ).stderr
    summary = log[log.rfind("Summary:"):]
    lufs = float(re.search(r"I:\s+(-?[\d.]+|-inf)", summary).group(1).replace("-inf", "-70"))
    peak = float(re.search(r"Peak:\s+(-?[\d.]+|-inf)", summary).group(1).replace("-inf", "-70"))
    return lufs, peak


def publish(name: str, spec: dict, gen: dict) -> str:
    src = RAW / f"{name}.mp3"
    lufs, peak = measure(src)
    target = gen["lufsLoop"] if spec.get("loop") else gen["lufsAvulso"]
    gain = min(target - lufs, gen["picoMax"] - peak)
    tmp = OUT / f"{name}.part.mp3"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(src), "-af", f"volume={gain:.2f}dB", "-c:a", "libmp3lame", "-b:a", "128k", str(tmp)],
        check=True,
    )
    tmp.replace(OUT / f"{name}.mp3")
    return f"{lufs:6.1f} LUFS, pico {peak:5.1f} -> {gain:+5.1f} dB"


def generate(key: str, sid: str, spec: dict, gen: dict) -> bytes:
    body = {
        "text": spec["prompt"],
        "duration_seconds": float(spec["dur"]),
        "prompt_influence": float(spec.get("influence", 0.3)),
        "model_id": gen["modelo"],
    }
    if spec.get("loop"):
        body["loop"] = True
    req = urllib.request.Request(
        f"{API}?output_format={gen['formato']}",
        data=json.dumps(body).encode("utf-8"),
        headers={"xi-api-key": key, "Content-Type": "application/json", "Accept": "audio/mpeg"},
        method="POST",
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                return resp.read()
        except urllib.error.HTTPError as err:
            detail = err.read().decode("utf-8", "replace")[:400]
            if err.code in (401, 402, 403) or "quota" in detail.lower() or "credits" in detail.lower():
                raise QuotaError(f"{sid}: HTTP {err.code} {detail}") from err
            if err.code == 429 or err.code >= 500:
                time.sleep(4 * (attempt + 1))
                continue
            raise RuntimeError(f"{sid}: HTTP {err.code} {detail}") from err
        except urllib.error.URLError:
            time.sleep(4 * (attempt + 1))
    raise RuntimeError(f"{sid}: sem resposta após 3 tentativas")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", default="", help="ids separados por vírgula")
    ap.add_argument("--force", action="store_true", help="refaz mesmo se o arquivo existir")
    ap.add_argument("--dry-run", action="store_true", help="só lista e estima o custo")
    ap.add_argument("--max-creditos", type=int, default=0, help="não ultrapassa este gasto (0 = sem teto)")
    ap.add_argument("--normalizar", action="store_true", help="só republica os brutos existentes")
    args = ap.parse_args()

    manifest = load_manifest()
    gen = manifest["gerador"]
    per_second = float(gen["creditosPorSegundo"])
    only = {s.strip() for s in args.only.split(",") if s.strip()}
    unknown = only - set(manifest["sons"])
    if unknown:
        print(f"ids desconhecidos: {', '.join(sorted(unknown))}", file=sys.stderr)
        return 2

    OUT.mkdir(parents=True, exist_ok=True)
    RAW.mkdir(parents=True, exist_ok=True)
    if args.normalizar:
        for sid, spec in manifest["sons"].items():
            if only and sid not in only:
                continue
            for name in variant_names(sid, spec):
                if (RAW / f"{name}.mp3").exists():
                    print(f"  {name:22s} {publish(name, spec, gen)}")
        return 0

    pending: list[tuple[str, str, dict]] = []
    for sid, spec in manifest["sons"].items():
        if only and sid not in only:
            continue
        for name in variant_names(sid, spec):
            if (RAW / f"{name}.mp3").exists() and not args.force:
                continue
            pending.append((name, sid, spec))

    total = sum(cost(s, per_second) for _, _, s in pending)
    print(f"{len(pending)} som(ns) a gerar, ~{total} créditos estimados")
    for name, _, spec in pending:
        print(f"  {name:22s} {spec['dur']:>4}s {'loop' if spec.get('loop') else '    '} ~{cost(spec, per_second)}")
    if args.dry_run or not pending:
        return 0

    key = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    if not key:
        print("defina ELEVENLABS_API_KEY no ambiente", file=sys.stderr)
        return 2

    spent = 0
    done = 0
    for name, sid, spec in pending:
        c = cost(spec, per_second)
        if args.max_creditos and spent + c > args.max_creditos:
            print(f"teto de {args.max_creditos} créditos atingido; parando antes de {name}")
            break
        try:
            audio = generate(key, name, spec, gen)
        except QuotaError as err:
            print(f"COTA/AUTENTICAÇÃO: {err}", file=sys.stderr)
            break
        except RuntimeError as err:
            print(f"falhou: {err}", file=sys.stderr)
            continue
        if len(audio) < 2000:
            print(f"falhou: {name} veio com {len(audio)} bytes", file=sys.stderr)
            continue
        tmp = RAW / f"{name}.mp3.part"
        tmp.write_bytes(audio)
        tmp.replace(RAW / f"{name}.mp3")
        spent += c
        done += 1
        print(f"ok {name} ({len(audio) // 1024} KB, ~{spent} créditos até aqui) {publish(name, spec, gen)}", flush=True)
    print(f"{done}/{len(pending)} gerados, ~{spent} créditos")
    return 0 if done == len(pending) else 1


if __name__ == "__main__":
    sys.exit(main())
