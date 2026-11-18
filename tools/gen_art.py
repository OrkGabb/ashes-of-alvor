#!/usr/bin/env python3
"""
Arte 2D via agy (gerador de imagens): retratos dos NPCs, ícones de itens e arte da tela de carregamento.

Os pedidos são montados a partir das fontes únicas (public/data/npcs.json e items.json), com um guia
de estilo comum para tudo sair coerente. Cada imagem bruta vai para assets_src/art_raw/ e a versão
otimizada para public/art/ (retratos 512 px JPEG, ícones 256 px PNG, key art 1600x900 JPEG).
Imagens já existentes são puladas (use --force para refazer, --only id1,id2 para filtrar).

Uso:
  python tools/gen_art.py [--jobs 3] [--force] [--only luna,ensopado] [--model gemini-3.8-flash-low]
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "assets_src" / "art_raw"
QUOTA = threading.Event()   # cota de imagem esgotada: para de disparar pedidos
OUT = ROOT / "public" / "art"

ESTILO_RETRATO = (
    "Ilustração de retrato busto (cabeça e ombros), estilo anime de light novel isekai de fantasia, "
    "traço limpo, cores ricas, iluminação quente e cinematográfica, rosto em 3/4 olhando para o espectador, "
    "fundo levemente desfocado, enquadramento quadrado 1:1, sem texto, sem moldura, sem marca d'água."
)
ESTILO_ICONE = (
    "Ícone de item de RPG em estilo anime pintado à mão, um único objeto centralizado ocupando cerca de 70% do quadro, "
    "fundo liso azul-noite escuro (#141a26) sem gradiente nem cenário, leve brilho de contorno, sombra suave, "
    "enquadramento quadrado 1:1, sem texto, sem moldura, sem marca d'água."
)


@dataclass(frozen=True)
class Job:
    key: str
    kind: str          # portrait | icon | keyart
    prompt: str

    @property
    def raw_path(self) -> Path:
        return RAW / self.kind / f"{self.key}.png"

    @property
    def out_path(self) -> Path:
        if self.kind == "portrait":
            return OUT / "portraits" / f"{self.key}.jpg"
        if self.kind == "icon":
            return OUT / "icons" / f"{self.key}.png"
        return OUT / f"{self.key}.jpg"


def build_jobs() -> list[Job]:
    npcs = json.loads((ROOT / "public" / "data" / "npcs.json").read_text(encoding="utf-8"))["npcs"]
    items = json.loads((ROOT / "public" / "data" / "items.json").read_text(encoding="utf-8"))
    jobs: list[Job] = []
    for key, npc in npcs.items():
        jobs.append(Job(key, "portrait", f"{ESTILO_RETRATO} Personagem: {npc['nome']}, {npc['titulo']}: {npc['aparencia']}. Cenário de fundo: {npc['cenario_retrato']}."))
    moeda = items["moeda"]
    jobs.append(Job(moeda["id"], "icon", f"{ESTILO_ICONE} Objeto: {moeda['icone_prompt']}."))
    for key, it in items["itens"].items():
        jobs.append(Job(key, "icon", f"{ESTILO_ICONE} Objeto: {it['icone_prompt']}."))
    jobs.append(Job("keyart", "keyart", (
        "Key art de jogo em estilo anime isekai de fantasia, formato paisagem 16:9: vista ampla da pequena capital murada "
        "'Cinzas de Alvor' à noite sob chuva fina, ruas de pedra molhadas refletindo lampiões quentes, casas enxaimel com "
        "telhados coloridos (azul, vermelho, verde-água), uma taverna aconchegante com placa de lanterna torta, a guilda de "
        "aventureiros com bandeiras azuis, um templo branco com vitrais dourados, um cristal de mana azul brilhando num "
        "monólito no centro da praça, castelo na colina ao fundo, céu noturno com nuvens e lua. Sem texto, sem marca d'água."
    )))
    return jobs


def run_agy(job: Job, model: str, timeout_s: int) -> bool:
    job.raw_path.parent.mkdir(parents=True, exist_ok=True)
    target = job.raw_path.resolve()
    prompt = (
        f"Gere UMA imagem usando sua ferramenta de geração de imagem. Descrição: {job.prompt}\n"
        f"Salve o resultado como PNG exatamente em: {target}\n"
        "Não crie nenhum outro arquivo. Responda apenas com o caminho salvo."
    )
    exe = shutil.which("agy")
    if not exe:
        raise SystemExit("agy não encontrado no PATH")
    argv = [exe, "-p", prompt, "--model", model, "--mode", "accept-edits", "--sandbox", "--add-dir", str(target.parent)]
    flags = {}
    if sys.platform == "win32":
        flags["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
    saida = ""
    try:
        proc = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout_s, cwd=str(target.parent),
                              text=True, encoding="utf-8", errors="replace", **flags)
        saida = (proc.stdout or "") + (proc.stderr or "")
    except subprocess.TimeoutExpired:
        pass
    if "429" in saida or "RESOURCE_EXHAUSTED" in saida or "quota" in saida.lower():
        QUOTA.set()
    # O subagente de imagem pode terminar de gravar logo depois do processo principal
    for _ in range(120):
        if target.is_file() and target.stat().st_size > 10_000:
            return True
        if QUOTA.is_set():
            break
        time.sleep(1.0)
    if target.is_file() and target.stat().st_size <= 10_000:
        target.unlink()
    return False


def optimize(job: Job) -> None:
    img = Image.open(job.raw_path).convert("RGB")
    job.out_path.parent.mkdir(parents=True, exist_ok=True)
    if job.kind == "portrait":
        side = min(img.size)
        img = img.crop(((img.width - side) // 2, 0, (img.width + side) // 2, side)).resize((512, 512), Image.LANCZOS)
        img.save(job.out_path, "JPEG", quality=88, optimize=True, progressive=True)
    elif job.kind == "icon":
        side = min(img.size)
        img = img.crop(((img.width - side) // 2, (img.height - side) // 2, (img.width + side) // 2, (img.height + side) // 2)).resize((256, 256), Image.LANCZOS)
        img.save(job.out_path, "PNG", optimize=True)
    else:
        w, h = img.size
        target_h = int(w * 9 / 16)
        if target_h <= h:
            img = img.crop((0, (h - target_h) // 2, w, (h + target_h) // 2))
        img = img.resize((1600, 900), Image.LANCZOS)
        img.save(job.out_path, "JPEG", quality=86, optimize=True, progressive=True)


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--jobs", type=int, default=3)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--only", default="")
    ap.add_argument("--model", default="gemini-3.8-flash-low")
    ap.add_argument("--timeout", type=int, default=600)
    args = ap.parse_args()
    only = {s.strip() for s in args.only.split(",") if s.strip()}
    jobs = [j for j in build_jobs() if not only or j.key in only]
    todo = []
    for j in jobs:
        if j.raw_path.is_file() and j.raw_path.stat().st_size <= 10_000:
            j.raw_path.unlink()
        if j.raw_path.is_file() and not args.force:
            if not j.out_path.is_file():
                optimize(j)
            continue
        todo.append(j)
    print(f"[arte] {len(jobs)} pedidos, {len(todo)} a gerar com {args.jobs} em paralelo", flush=True)
    failed: list[str] = []
    with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        def guarded(job: Job) -> bool:
            return False if QUOTA.is_set() else run_agy(job, args.model, args.timeout)
        futs = {pool.submit(guarded, j): j for j in todo}
        for fut in as_completed(futs):
            j = futs[fut]
            ok = False
            try:
                ok = fut.result()
            except Exception as exc:  # noqa: BLE001
                print(f"[arte] {j.kind}/{j.key}: erro {exc}", flush=True)
            if ok:
                optimize(j)
                print(f"[arte] OK {j.kind}/{j.key} -> {j.out_path.relative_to(ROOT)}", flush=True)
            else:
                failed.append(f"{j.kind}/{j.key}")
                print(f"[arte] FALHOU {j.kind}/{j.key}", flush=True)
    if QUOTA.is_set():
        print("[arte] cota de geração de imagem do agy esgotada; rode este script de novo mais tarde para completar", flush=True)
    if failed:
        print(f"[arte] {len(failed)} falharam: {failed} (rode de novo para tentar só esses)", flush=True)
        return 1
    print("[arte] tudo pronto", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
