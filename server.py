#!/usr/bin/env python3
"""
Servidor Backend HTTP + SSE (Server-Sent Events) para o RPG 3D 'Cinzas de Alvor'.
- Serve a aplicação 3D estática a partir da pasta 'public/' (index.html, app.js, assets/alvor_town.glb).
- Expõe GET /api/state para carregar a cena inicial, histórico e estado atual de relação/memória.
- Expõe POST /api/chat com streaming em tempo real via Server-Sent Events (SSE) utilizando o CLI 'agy'
  (gemini-4-hydrogen-low; o roteador play.escolher_modelo sobe para gemini-4-hydrogen-medium por turno quando a
  conversa pede raciocínio, salvo modelo/esforço forçado), injetando o contexto de 'historias/Isekai/' e as
  regras do 'GEMINI.md'.
- Realiza parsing transparente da tag <estado>{...}</estado> no backend via FiltroStream e
  extrair_narracao_e_estado, persistindo afeto (proximidade, confiança, tensão slow-burn),
  humor/crenças (humor, intenção, Bram/NPCs) e memória (relacao.json + memoria.txt) sem exibir
  tags na interface do jogador.
- Estado de jogo autoritativo (jogo.EstadoJogo): POST /api/acao recolhe itens no mundo e o chat
  processa a entrega ANTES de chamar o narrador; o evento sai num frame SSE "event" e entra no
  prompt como fato de jogo. A tarefa exibida no HUD é derivada da etapa da missão. Combate: /api/acao
  também equipa armas, registra abates (recompensa sorteada aqui) e a derrota (local de respawn).
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import subprocess
import sys
import threading
import time
from datetime import datetime
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

import jogo
import play

ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"
DEFAULT_HISTORIA = ROOT / "historias" / "Isekai"
CITY_FILE = PUBLIC_DIR / "assets" / "city" / "city.json"

# Garante MIME types corretos para módulos ES6 e modelos 3D glTF/GLB no Windows
mimetypes.init()
mimetypes.add_type("application/javascript; charset=utf-8", ".js")
mimetypes.add_type("application/javascript; charset=utf-8", ".mjs")
mimetypes.add_type("text/css; charset=utf-8", ".css")
mimetypes.add_type("text/html; charset=utf-8", ".html")
mimetypes.add_type("model/gltf-binary", ".glb")
mimetypes.add_type("model/gltf+json", ".gltf")
mimetypes.add_type("application/json; charset=utf-8", ".json")
mimetypes.add_type("image/png", ".png")
mimetypes.add_type("audio/mpeg", ".mp3")


def obter_estado_publico(cena: play.Cena, estado_jogo: jogo.EstadoJogo) -> dict[str, Any]:
    """Retorna o estado estruturado da relação, humor, NPCs, memória e jogo para o HUD 3D."""
    r = cena.relacao.d
    estagio_nome, estagio_ritmo = cena.relacao.estagio()
    return {
        "proximidade": round(float(r.get("proximidade", 0.0)), 3),
        "confianca": round(float(r.get("confianca", 0.0)), 3),
        "tensao": round(float(r.get("tensao", 0.0)), 3),
        "estagio": estagio_nome,
        "ritmo": estagio_ritmo,
        "humor": str(r.get("humor") or "curiosa e irônica"),
        "intencao": str(r.get("intencao") or "observar como o forasteiro reage"),
        "npcs": dict(r.get("npcs") or {}),
        "lembrancas": list(r.get("lembrancas") or [])[-10:],
        "turnos": int(r.get("turnos", 0)),
        **estado_jogo.publico(),
    }


def streaming_agy(
    motor: play.MotorAgy,
    sistema: str,
    mensagens: list[dict[str, str]],
    on_token: Callable[[str], None],
    model_id: str = "",
    effort: str = "",
) -> tuple[str, bool]:
    """
    Executa o CLI 'agy' fazendo streaming da saída visível filtrada por FiltroStream (ocultando <think> e
    <estado> em tempo real). model_id/effort escolhidos por turno não mexem no motor compartilhado entre threads;
    vazios usam os do motor.
    """
    conversa = "\n\n".join(
        f"{'JOGADOR' if m['role'] == 'user' else 'NARRADOR'}: {m['content']}"
        for m in mensagens
    )
    prompt = f"{sistema}\n\n# Conversa Recente\n{conversa}\n\nEscreva a resposta agora:"
    argv = [
        motor.exe,
        f"-p={prompt[-14000:]}",
        "--model",
        model_id or motor.model_id,
        "--effort",
        effort or motor.effort,
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

    filtro = play.FiltroStream()
    partes_brutas: list[str] = []

    proc = subprocess.Popen(
        argv,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        **flags,
    )

    timed_out = False

    def _kill_on_timeout() -> None:
        nonlocal timed_out
        timed_out = True
        try:
            proc.kill()
        except OSError:
            pass

    stderr_chunks: list[str] = []

    def _drain_stderr() -> None:
        if proc.stderr is None:
            return
        try:
            stderr_chunks.append(proc.stderr.read())
        except OSError:
            pass

    stderr_thread = threading.Thread(target=_drain_stderr, daemon=True)
    stderr_thread.start()
    watchdog = threading.Timer(motor.timeout_s, _kill_on_timeout)
    watchdog.daemon = True
    watchdog.start()

    try:
        assert proc.stdout is not None
        # Leitura imediata via buffer.read1 para evitar qualquer represamento de tokens
        import codecs

        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        raw_stream = getattr(proc.stdout, "buffer", proc.stdout)

        while True:
            if hasattr(raw_stream, "read1"):
                chunk_bytes = raw_stream.read1(1024)
            else:
                chunk_bytes = raw_stream.read(1)
            if not chunk_bytes:
                break
            pedaco = decoder.decode(chunk_bytes)
            if pedaco:
                pedaco = pedaco.replace("\r\n", "\n").replace("\r", "\n")
                partes_brutas.append(pedaco)
                visivel = filtro.feed(pedaco)
                if visivel:
                    on_token(visivel)

        tail = decoder.decode(b"", final=True)
        if tail:
            tail = tail.replace("\r\n", "\n").replace("\r", "\n")
            partes_brutas.append(tail)
            visivel = filtro.feed(tail)
            if visivel:
                on_token(visivel)

        proc.wait(timeout=10)
    finally:
        watchdog.cancel()
        if proc.poll() is None:
            proc.kill()
        stderr_thread.join(timeout=2.0)

    if timed_out:
        raise RuntimeError(f"Tempo limite excedido ({motor.timeout_s:.0f}s) ao aguardar o agy.")

    stderr_txt = "".join(stderr_chunks)
    bruto = "".join(partes_brutas).strip()
    if proc.returncode != 0:
        detalhe = (stderr_txt + "\n" + bruto).strip()[-400:]
        raise RuntimeError(f"agy saiu com código {proc.returncode}: {detalhe}")
    if not bruto:
        raise RuntimeError("agy retornou saída vazia.")

    resto = filtro.flush()
    if resto:
        on_token(resto)

    return bruto, False


class EstadoServidor:
    """Mantém a instância da Cena de Cinzas de Alvor, motor de IA e sincronização de turnos."""

    def __init__(
        self,
        pasta_historia: Path = DEFAULT_HISTORIA,
        motor_nome: str = "agy",
        modelo: str = "",
        effort: str = "",
        allow_fallback: bool = True,
    ) -> None:
        self.lock = threading.Lock()
        self.pasta_historia = pasta_historia
        self.cena = play.Cena(pasta_historia)
        self.dados = jogo.carregar_dados()
        self.jogo = jogo.EstadoJogo(self.cena.relacao, play.ler_texto(pasta_historia / "memoria.txt"), self.dados)
        self.motor_nome = motor_nome
        self.modelo = modelo
        self.effort = effort
        self.allow_fallback = allow_fallback
        self.motor_teste = play.MotorTeste()
        self.motor = self._criar_motor(motor_nome, modelo, effort)
        # Roteamento por turno só com o agy e sem modelo/esforço forçado (play.roteamento_ativo)
        self.rotear = isinstance(self.motor, play.MotorAgy) and play.roteamento_ativo(modelo, effort)

    def _criar_motor(self, motor_nome: str, modelo: str, effort: str) -> play.Motor:
        if motor_nome == "teste":
            return self.motor_teste
        if motor_nome == "lmstudio":
            cfg = play.ler_config()
            return play.MotorLMStudio(
                modelo or cfg.get("Modelo", "roleplay-local"),
                play.num(cfg.get("Temperatura", "0.8").replace(",", "."), 0.0, 2.0, 0.8),
                int(play.num(cfg.get("MaxTokens", "700"), 50, 8000, 700)),
            )
        try:
            return play.MotorAgy(model_id=modelo, effort=effort)
        except Exception as e:  # noqa: BLE001
            play.aviso(f"Não foi possível inicializar agy ({e}); usando MotorTeste como fallback.")
            return self.motor_teste

    def nova_jornada(self) -> None:
        """Reinício completo: histórico, relação, estado de jogo e memória (com backup da memória anterior)."""
        mem_path = self.pasta_historia / "memoria.txt"
        if mem_path.is_file():
            backup = self.pasta_historia / f"memoria-backup-{datetime.now():%Y%m%d-%H%M%S}.bak"
            backup.write_text(mem_path.read_text(encoding="utf-8"), encoding="utf-8")
            mem_path.write_text(play.MEMORIA_PADRAO, encoding="utf-8")
        rel_path = self.cena.dir / "relacao.json"
        if rel_path.is_file():
            rel_path.unlink()
        self.cena = play.Cena(self.pasta_historia)
        self.jogo = jogo.EstadoJogo(self.cena.relacao, play.ler_texto(mem_path), self.dados)
        self.jogo.reiniciar()

    def estado_publico(self) -> dict[str, Any]:
        return obter_estado_publico(self.cena, self.jogo)

    def escolher_modelo(self, motor: play.Motor, texto: str, contexto: dict[str, Any] | None, cena: dict[str, Any]) -> play.EscolhaModelo:
        """Modelo deste turno: roteado (enigma, dedução, mensagem longa) ou o fixo do motor."""
        if not (self.rotear and isinstance(motor, play.MotorAgy)):
            return play.EscolhaModelo(motor.model_id, str(getattr(motor, "effort", "")), "fixo")
        ctx = play.ContextoRoteamento(
            local=str((contexto or {}).get("local") or ""),
            marco=str(cena.get("marco") or "")[:40],
            pistas=self.jogo.pistas_roteamento(),
        )
        return play.escolher_modelo(texto, ctx)

    def contexto_cena(self, corpo: dict[str, Any]) -> tuple[dict[str, Any] | None, str]:
        """Monta a cena (interlocutor, presentes, local, hora, clima) a partir do que o cliente 3D informa.
        Personas vêm sempre do npcs.json do servidor; o cliente só diz QUEM está onde."""
        npcs = self.dados["npcs"]["npcs"]
        alvo = str(corpo.get("npc") or "").strip().lower()
        if alvo not in npcs:
            return None, ""
        cena = corpo.get("cena") if isinstance(corpo.get("cena"), dict) else {}
        atividades = {str(p.get("id")): str(p.get("atividade") or "")[:120] for p in (cena.get("presentes") or []) if isinstance(p, dict)}

        def ficha(npc_id: str) -> dict[str, str]:
            d = npcs[npc_id]
            return {"id": npc_id, "nome": d["nome"], "titulo": d["titulo"], "persona": d["persona"], "atividade": atividades.get(npc_id, "")}

        presentes = [ficha(i) for i in atividades if i in npcs and i != alvo][:4]
        return {
            "interlocutor": ficha(alvo),
            "presentes": presentes,
            "local": str(cena.get("local") or "")[:80],
            "hora": str(cena.get("hora") or "")[:10],
            "clima": str(cena.get("clima") or "")[:40],
        }, alvo


LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "[::1]"})


class AlvorRequestHandler(SimpleHTTPRequestHandler):
    """Handler HTTP que serve 'public/' e as rotas da API do RPG (/api/state, /api/chat, /api/reset, /api/note).

    A API só atende o próprio jogo: qualquer página aberta no navegador consegue mandar requisições para
    127.0.0.1, então o Host precisa ser local (contra DNS rebinding), um Origin presente precisa ser o do
    próprio servidor e o POST precisa ser JSON (que força preflight, e o preflight não libera outra origem).
    Sem cabeçalhos CORS: o cliente é servido pela mesma origem."""

    server_version = "AlvorRPG3D/1.0"
    protocol_version = "HTTP/1.1"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(PUBLIC_DIR), **kwargs)

    @property
    def app(self) -> EstadoServidor:
        return self.server.app_state  # type: ignore[attr-defined]

    def end_headers(self) -> None:
        # Assets regenerados (GLB, texturas, módulos JS) precisam ser revalidados a cada carga
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write(f"[HTTP] {self.address_string()} - {fmt % args}\n")

    def handle(self) -> None:
        try:
            super().handle()
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            pass

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _origem_permitida(self) -> bool:
        """Host local (ou o host em que o servidor foi ligado) e Origin, se houver, igual ao próprio servidor."""
        host = (self.headers.get("Host") or "").strip().lower()
        nome = host.rsplit(":", 1)[0] if not host.endswith("]") else host
        ligado = str(self.server.server_address[0]).lower()  # type: ignore[attr-defined]
        if ligado not in ("0.0.0.0", "::", "") and nome not in LOOPBACK_HOSTS and nome != ligado:
            return False
        origem = self.headers.get("Origin")
        return origem is None or origem.strip().lower() == f"http://{host}"

    def _recusar_origem(self) -> bool:
        if self._origem_permitida():
            return False
        self._send_json(HTTPStatus.FORBIDDEN, {"ok": False, "error": "Origem não permitida."})
        return True

    def _read_json_body(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return {}
        if length <= 0:
            return {}
        raw = self.rfile.read(min(length, 65536))
        try:
            data = json.loads(raw.decode("utf-8", errors="replace"))
            return data if isinstance(data, dict) else {}
        except ValueError:
            return {}

    def do_OPTIONS(self) -> None:
        # Preflight de outra origem: sem cabeçalhos CORS, o navegador bloqueia a requisição real
        self.send_response(HTTPStatus.NO_CONTENT if self._origem_permitida() else HTTPStatus.FORBIDDEN)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/favicon.ico":
            self.send_response(HTTPStatus.NO_CONTENT)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        if parsed.path.startswith("/api/") and self._recusar_origem():
            return

        if parsed.path == "/api/state":
            with self.app.lock:
                # Uma conversa por NPC (a janela do jogo mostra só a do interlocutor); "history" = narrador geral
                historicos = {
                    npc: [{"role": m["role"], "content": play.limpar_narracao(m["content"])} for m in msgs]
                    for npc, msgs in self.app.cena.historicos.items()
                }
                payload = {
                    "ok": True,
                    "opening": self.app.cena.texto_abertura(),
                    "history": historicos.get("", []),
                    "histories": {k: v for k, v in historicos.items() if k},
                    "state": self.app.estado_publico(),
                    "motor": {
                        "provider": self.app.motor.provider_id,
                        "model": self.app.motor.model_id,
                        "effort": getattr(self.app.motor, "effort", "low"),
                        "routing": self.app.rotear,
                    },
                }
            self._send_json(HTTPStatus.OK, payload)
            return

        if parsed.path == "/api/health":
            stats: dict[str, Any] = {}
            if CITY_FILE.is_file():
                try:
                    stats = json.loads(CITY_FILE.read_text(encoding="utf-8")).get("stats", {})
                except ValueError:
                    stats = {}
            self._send_json(
                HTTPStatus.OK,
                {"ok": True, "city_exists": CITY_FILE.is_file(), "motor": self.app.motor.model_id, "assets": stats},
            )
            return

        return super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if self._recusar_origem():
            return
        tipo = (self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
        if tipo != "application/json":
            self._send_json(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, {"ok": False, "error": "Use Content-Type: application/json."})
            return
        if parsed.path == "/api/chat":
            self._handle_chat_sse()
            return
        if parsed.path == "/api/note":
            self._handle_note()
            return
        if parsed.path == "/api/reset":
            self._handle_reset()
            return
        if parsed.path == "/api/acao":
            self._handle_acao()
            return
        self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": f"Rota não encontrada: {parsed.path}"})

    def _handle_acao(self) -> None:
        """Ações de mundo (coletar, aceitar, comprar, usar, visitar...), resolvidas sem chamar o narrador."""
        body = self._read_json_body()
        acao = str(body.get("acao") or "").strip().lower()
        with self.app.lock:
            resultado = self.app.jogo.executar(acao, body)
            if resultado.evento == "acao_desconhecida":
                self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": resultado.mensagem})
                return
            estado_pub = self.app.estado_publico()
        payload: dict[str, Any] = {"ok": resultado.ok, "event": resultado.evento, "message": resultado.mensagem, "state": estado_pub,
                                   "effect": resultado.efeito, "gained": resultado.itens_ganhos}
        for chave, valor in resultado.extra.items():
            payload.setdefault(chave, valor)  # campos novos (cobre, respawn...) nunca trocam os de sempre
        self._send_json(HTTPStatus.OK, payload)

    def _handle_note(self) -> None:
        body = self._read_json_body()
        nota = str(body.get("note") or body.get("texto") or "").strip()
        if not nota:
            self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "Nota vazia."})
            return
        with self.app.lock:
            adicionado = self.app.cena.relacao.adicionar_lembranca(nota)
            self.app.cena.relacao.salvar()
            self.app.cena.sincronizar_memoria_txt(nota)
            estado_pub = self.app.estado_publico()
        self._send_json(HTTPStatus.OK, {"ok": True, "added": adicionado, "state": estado_pub})

    def _handle_reset(self) -> None:
        body = self._read_json_body()
        nova_jornada = bool(body.get("full", False))
        with self.app.lock:
            self.app.cena.limpar_historicos()
            if nova_jornada:
                self.app.nova_jornada()
            estado_pub = self.app.estado_publico()
            abertura = self.app.cena.texto_abertura()
        self._send_json(HTTPStatus.OK, {"ok": True, "opening": abertura, "state": estado_pub})

    def _handle_chat_sse(self) -> None:
        body = self._read_json_body()
        texto_usuario = str(
            body.get("message") or body.get("text") or body.get("prompt") or body.get("input") or ""
        ).replace("\ufeff", "").strip()

        if not texto_usuario:
            self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "Mensagem do jogador não pode ser vazia."})
            return

        motor_override = str(body.get("motor") or "").strip().lower()
        acao = str(body.get("acao") or "").strip().lower()
        contexto, alvo = self.app.contexto_cena(body)
        if not acao and jogo.eh_entrega_digitada(texto_usuario) and alvo in ("", "bram"):
            acao = jogo.ACAO_ENTREGAR

        # Configura cabeçalhos Server-Sent Events (SSE)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.close_connection = True

        def send_sse(payload: dict[str, Any] | str) -> None:
            try:
                if isinstance(payload, str):
                    frame = f"data: {payload}\n\n"
                else:
                    frame = f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
                self.wfile.write(frame.encode("utf-8"))
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass

        # 1. Ação de jogo resolvida de forma determinística ANTES do narrador
        texto_modelo = texto_usuario
        contexto_evento = ""
        with self.app.lock:
            if acao:
                corpo_acao = {**body, "npc": body.get("npc") or ("bram" if acao == jogo.ACAO_ENTREGAR else "")}
                resultado = self.app.jogo.executar(acao, corpo_acao)
                contexto_evento = resultado.contexto_narrador
                if not resultado.ok and acao == jogo.ACAO_ENTREGAR:
                    # O narrador não deve encenar uma entrega que não aconteceu
                    texto_modelo = "[Procura o feixe nas mãos, mas não carrega nenhum]"
                elif not resultado.ok:
                    texto_modelo = f"{texto_usuario} [Isso não acontece: {resultado.mensagem}]"
                send_sse({
                    "type": "event",
                    "event": resultado.evento,
                    "ok": resultado.ok,
                    "message": resultado.mensagem,
                    "state": self.app.estado_publico(),
                    "gained": resultado.itens_ganhos,
                })
            sistema = play.montar_sistema_narrador(self.app.cena, contexto) + "\n\n" + self.app.jogo.bloco_narrador(contexto_evento, alvo)
            mensagens = self.app.cena.mensagens_para_llm(texto_modelo, 3500, npc=alvo)
            motor_ativo: play.Motor = (
                self.app.motor_teste if motor_override == "teste" else self.app.motor
            )
            cena_cliente = body.get("cena") if isinstance(body.get("cena"), dict) else {}
            escolha = self.app.escolher_modelo(motor_ativo, texto_usuario, contexto, cena_cliente)

        tokens_emitidos: list[str] = []

        def on_token(pedaco_visivel: str) -> None:
            if not pedaco_visivel:
                return
            tokens_emitidos.append(pedaco_visivel)
            send_sse({"type": "token", "token": pedaco_visivel})

        try:
            if isinstance(motor_ativo, play.MotorAgy):
                try:
                    bruto, cortou = streaming_agy(motor_ativo, sistema, mensagens, on_token, escolha.model_id, escolha.effort)
                    modelo_usado = escolha.model_id
                except Exception as err_agy:  # noqa: BLE001
                    if not self.app.allow_fallback or tokens_emitidos:
                        raise
                    play.aviso(f"Falha no agy ({err_agy}); usando motor local de contingência.")
                    bruto, cortou = self.app.motor_teste.narrar(sistema, mensagens, on_token)
                    modelo_usado = self.app.motor_teste.model_id
            else:
                bruto, cortou = motor_ativo.narrar(sistema, mensagens, on_token)
                modelo_usado = motor_ativo.model_id
                if isinstance(motor_ativo, play.MotorTeste):
                    time.sleep(0.01)

            # Extrai narração limpa (sem <estado>) e o dicionário de estado atualizado
            narracao, estado = play.extrair_narracao_e_estado(bruto, texto_modelo)
            if not narracao:
                raise RuntimeError("O modelo retornou uma narração vazia.")

            # A tarefa é derivada da etapa da missão (SSOT em jogo.EstadoJogo), nunca do texto do modelo
            estado.pop("tarefa", None)
            if contexto:
                nome_alvo = contexto["interlocutor"]["nome"]
                atitude = estado.pop("npc", None)
                npcs_estado = dict(estado["npcs"]) if isinstance(estado.get("npcs"), dict) else {}
                if atitude:
                    npcs_estado[nome_alvo] = atitude
                if alvo != "bram" and not any(p["id"] == "bram" for p in contexto["presentes"]):
                    estado.pop("bram", None)
                estado["npcs"] = npcs_estado
                if alvo != "luna" and not any(p["id"] == "luna" for p in contexto["presentes"]):
                    # Slow-burn: a relação com a Luna só se move com ela em cena
                    estado["relacao"] = {"proximidade": 0.0, "confianca": 0.0, "tensao": 0.0}
                    estado.pop("humor", None)
                    estado.pop("intencao", None)
            with self.app.lock:
                deltas = self.app.cena.salvar_turno(texto_usuario, narracao, modelo_usado, estado, npc=alvo)
                self.app.jogo.sincronizar_tarefa()
                self.app.cena.relacao.salvar()
                estado_publico = self.app.estado_publico()

            send_sse(
                {
                    "type": "done",
                    "narration": narracao,
                    "state": estado_publico,
                    "deltas": deltas,
                    "truncated": cortou,
                    "model": modelo_usado,
                    "model_reason": escolha.motivo if modelo_usado == escolha.model_id else "contingência",
                }
            )
            send_sse("[DONE]")
        except Exception as exc:  # noqa: BLE001
            send_sse({"type": "error", "error": str(exc)})
            send_sse("[DONE]")


def criar_servidor(
    host: str = "127.0.0.1",
    port: int = 8000,
    pasta_historia: Path = DEFAULT_HISTORIA,
    motor_nome: str = "agy",
    modelo: str = "",
    effort: str = "",
    allow_fallback: bool = True,
) -> ThreadingHTTPServer:
    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)
    httpd = ThreadingHTTPServer((host, port), AlvorRequestHandler)
    httpd.app_state = EstadoServidor(  # type: ignore[attr-defined]
        pasta_historia=pasta_historia,
        motor_nome=motor_nome,
        modelo=modelo,
        effort=effort,
        allow_fallback=allow_fallback,
    )
    return httpd


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass

    cfg = play.ler_config()
    ap = argparse.ArgumentParser(description="Servidor 3D Web + SSE para Cinzas de Alvor")
    ap.add_argument("--host", default="127.0.0.1", help="Endereço de escuta (padrão: 127.0.0.1)")
    ap.add_argument("--port", type=int, default=8000, help="Porta HTTP (padrão: 8000)")
    ap.add_argument(
        "--motor",
        choices=("agy", "lmstudio", "teste"),
        default=cfg.get("Motor", "agy").lower(),
        help=f"Motor de IA: agy ({play.MODELO_PADRAO}, roteando para {play.MODELO_PROFUNDO} quando preciso), lmstudio ou teste",
    )
    ap.add_argument("--modelo", default="",
                    help=f"Força um modelo do Gemini/LM Studio e desliga o roteamento (padrão: {play.MODELO_PADRAO} roteado)")
    ap.add_argument("--effort", choices=("low", "medium", "high"), default="",
                    help="Força o esforço do agy e desliga o roteamento (padrão: low, medium nos turnos roteados)")
    ap.add_argument("--pasta", default=str(DEFAULT_HISTORIA), help="Pasta da história (padrão: historias/Isekai)")
    ap.add_argument("--no-fallback", action="store_true", help="Desativa fallback automático caso o agy falhe")
    args = ap.parse_args(argv)

    pasta = Path(args.pasta)
    pasta = (pasta if pasta.is_absolute() else ROOT / pasta).resolve()

    httpd = criar_servidor(
        host=args.host,
        port=args.port,
        pasta_historia=pasta,
        motor_nome=args.motor,
        modelo=args.modelo or play.modelo_do_config(cfg),
        effort=args.effort,
        allow_fallback=not args.no_fallback,
    )
    url = f"http://{args.host if args.host != '0.0.0.0' else 'localhost'}:{args.port}"
    print("============================================================")
    print("  CINZAS DE ALVOR 3D — Servidor Web & Motor de Diálogo SSE")
    print(f"  URL:      {url}")
    print(f"  História: {pasta}")
    app_state: EstadoServidor = httpd.app_state  # type: ignore[attr-defined]
    roteado = f" -> {play.MODELO_PROFUNDO} quando preciso" if app_state.rotear else ""
    print(f"  Motor:    {app_state.motor.provider_id} ({app_state.motor.model_id}{roteado})")
    print("============================================================")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nEncerrando servidor...")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
