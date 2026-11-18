#!/usr/bin/env python3
"""
Ponta a ponta do estado de jogo v2 contra um processo REAL do server.py (motor 'teste', sem rede),
sempre numa cópia temporária da história (o save do jogador nunca é tocado).

1. Migração: um relacao.json no formato v1 (lenha entregue, Bram em 40%) é carregado pelo servidor.
   O estado migrado precisa responder o que só os dados preservados respondem: a Luna oferece
   'O Mapa da Capital' (exige a lenha concluída), a confiança de Bram é 0,40 e o cobre inclui a
   recompensa. Controle negativo: o mesmo save SEM migração (estrutura nova) falha essas perguntas.
2. Missões em etapas (coletar -> entregar, pagar, falar, visitar), loja, consumíveis e cartão da Guilda.
3. Chat com contexto de NPC: fala com a Sera sem a Luna em cena não move a relação com a Luna, e a
   atitude da Sera é gravada.
4. Tudo persiste após reiniciar o processo (lido do disco).

Execução:
  python test_jogo_v2.py
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
from pathlib import Path

import jogo
import play
from test_server_live import LiveServer, check

ROOT = Path(__file__).resolve().parent
SOURCE_STORY = ROOT / "historias" / "Isekai"

SAVE_V1 = {
    "proximidade": 0.0, "confianca": 0.0, "tensao": 0.0,
    "humor": "curiosa e irônica",
    "intencao": "observar como o forasteiro reage ao Bram e sondar de onde ele veio",
    "npcs": {"Bram": "satisfeito com a lenha entregue, servindo o ensopado quente prometido"},
    "lembrancas": [], "tarefa": "Ensopado liberado — Bram passou a confiar mais em você", "turnos": 0, "historico": [],
    "jogo": {"inventario": {"tem_lenha": False}, "missoes": {"lenha_bram": "concluida"},
             "desbloqueios": {"ensopado": True}, "confianca_npc": {"Bram": 0.4}},
}


def new_story(tmp: Path, save: dict | None) -> Path:
    story = tmp / "Isekai"
    shutil.copytree(SOURCE_STORY, story, ignore=shutil.ignore_patterns("sessao-*.txt", "*.bak"))
    (story / "luna" / "historico.json").write_text("[]", encoding="utf-8")
    if save is not None:
        (story / "luna" / "relacao.json").write_text(json.dumps(save, ensure_ascii=False), encoding="utf-8")
    return story


def disk(story: Path) -> dict:
    return json.loads((story / "luna" / "relacao.json").read_text(encoding="utf-8"))


def migrated_answers(state: dict) -> bool:
    """As perguntas que só um save v1 preservado responde certo."""
    return (
        state["missao_lenha"] == "concluida"
        and abs(state["confianca_npc"].get("bram", 0) - 0.4) < 1e-9
        and "mapa_capital" in state["missoes_disponiveis"].get("luna", [])
        and "lenha_bram" not in sum(state["missoes_disponiveis"].values(), [])
        and state["cobre"] == 3 + 5
    )


def run() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="alvor_v2_"))
    try:
        print("=== 1. Migração do save v1 (o mesmo formato do save atual do jogador) ===")
        story = new_story(tmp / "a", SAVE_V1)
        with LiveServer(story) as srv:
            st = srv.get("/api/state")["state"]
            check(migrated_answers(st), f"save v1 migrado: lenha concluída, Bram 0.40, Luna oferece o mapa, cobre {st['cobre']}")
        on = disk(story)["jogo"]
        check(on["versao"] == 2 and on["confianca_npc"]["bram"] == 0.4 and on["missoes"]["lenha_bram"]["estado"] == "concluida",
              "relacao.json reescrito no formato v2 com a confiança e a missão preservadas")
        # Controle negativo: o mesmo save, mas carregado sem migração (estrutura nova por cima)
        rel = play.Relacao(tmp / "neg.json")
        rel.d.update(json.loads(json.dumps(SAVE_V1)))
        orig = jogo.EstadoJogo._migrar_v1
        try:
            jogo.EstadoJogo._migrar_v1 = lambda self, antigo, mem: self.estrutura_inicial()
            sem = jogo.EstadoJogo(rel, "")
        finally:
            jogo.EstadoJogo._migrar_v1 = orig
        st_neg = {**sem.publico()}
        check(not migrated_answers(st_neg), "controle negativo: sem a migração o save perde a lenha e a confiança (as perguntas falham)")

        print("=== 2. Missões em etapas, loja, consumíveis ===")
        story = new_story(tmp / "b", None)
        with LiveServer(story) as srv:
            srv.post("/api/reset", {"full": True})
            st = srv.get("/api/state")["state"]
            check(st["cobre"] == 3 and st["itens"] == {"espada_curta": 1, "cajado_aprendiz": 1} and st["equipado"] == {"arma": "espada_curta"},
                  "jornada nova: 3 cobres e só as armas iniciais na bolsa (espada equipada)")
            check("lente_darian" not in st["missoes_disponiveis"].get("darian", []), "contrato do Darian exige cartão da Guilda (ainda indisponível)")
            r = srv.post("/api/acao", {"acao": "coletar", "alvo": "erva_1"})
            check(r["ok"] is False, "não colhe Erva-de-Brasa sem a missão da Sera")
            r = srv.post("/api/acao", {"acao": "aceitar", "missao": "ervas_sera", "npc": "sera"})
            check(r["ok"] and r["state"]["missoes"]["ervas_sera"]["etapa"] == 0, "missão da Sera aceita")
            for k in ("erva_1", "erva_2"):
                srv.post("/api/acao", {"acao": "coletar", "alvo": k})
            r = srv.post("/api/acao", {"acao": "concluir", "missao": "ervas_sera", "npc": "sera"})
            check(r["ok"] is False and r["event"] == "etapa_automatica", "com 2 ervas a etapa de colher ainda não terminou")
            r = srv.post("/api/acao", {"acao": "coletar", "alvo": "erva_3"})
            check(r["state"]["missoes"]["ervas_sera"]["etapa"] == 1 and r["state"]["itens"]["erva_brasa"] == 3, "3ª erva avança a etapa sozinha")
            r = srv.post("/api/acao", {"acao": "coletar", "alvo": "erva_3"})
            check(r["ok"] is False and r["event"] == "ja_coletado", "o mesmo ramo não se colhe duas vezes")
            r = srv.post("/api/acao", {"acao": "concluir", "missao": "ervas_sera", "npc": "bram"})
            check(r["ok"] is False and r["event"] == "npc_errado", "entregar as ervas para outra pessoa é recusado")
            r = srv.post("/api/acao", {"acao": "concluir", "missao": "ervas_sera", "npc": "sera"})
            s2 = r["state"]
            check(r["ok"] and s2["missoes"]["ervas_sera"]["estado"] == "concluida" and s2["cobre"] == 9 and s2["itens"].get("cha_brasa") == 2
                  and "erva_brasa" not in s2["itens"], "ervas entregues: +6 cobres, 2 chás, ervas consumidas")
            r = srv.post("/api/acao", {"acao": "aceitar", "missao": "registro_guilda", "npc": "maren"})
            r = srv.post("/api/acao", {"acao": "concluir", "missao": "registro_guilda", "npc": "maren"})
            check(r["ok"] is False and r["event"] == "sem_cobre" and r["state"]["cobre"] == 9, "taxa de 10 cobres recusada com 9 (nada é descontado)")
            srv.post("/api/acao", {"acao": "coletar", "alvo": "lenha_patio"})
            r = srv.post("/api/acao", {"acao": "concluir", "missao": "lenha_bram", "npc": "bram"})
            check(r["ok"] and r["state"]["cobre"] == 14 and r["state"]["itens"].get("ensopado") == 1, "lenha entregue: +5 cobres e uma tigela de ensopado na bolsa")
            r = srv.post("/api/acao", {"acao": "concluir", "missao": "registro_guilda", "npc": "maren"})
            check(r["ok"] and r["state"]["cobre"] == 4 and r["state"]["itens"].get("cartao_guilda") == 1, "registro pago: cartão de aventureiro na bolsa")
            check("lente_darian" in r["state"]["missoes_disponiveis"].get("darian", []), "com o cartão, o contrato do Darian aparece")
            r = srv.post("/api/acao", {"acao": "comprar", "item": "pocao_vigor", "npc": "rosa"})
            check(r["ok"] is False and r["event"] == "fora_da_loja", "a Rosa não vende poções")
            r = srv.post("/api/acao", {"acao": "comprar", "item": "pao_centeio", "npc": "rosa"})
            check(r["ok"] and r["state"]["cobre"] == 1 and r["state"]["itens"]["pao_centeio"] == 1, "pão comprado por 3 cobres")
            r = srv.post("/api/acao", {"acao": "comprar", "item": "pao_centeio", "npc": "rosa"})
            check(r["ok"] is False and r["event"] == "sem_cobre" and r["state"]["cobre"] == 1, "sem cobre, sem pão (carteira intacta)")
            srv.post("/api/acao", {"acao": "sincronizar_status", "status": {"vigor": 20, "calor": 30}})
            r = srv.post("/api/acao", {"acao": "usar", "item": "pao_centeio"})
            check(r["ok"] and r["effect"].get("vigor") == 30 and r["state"]["status"]["vigor"] == 50 and "pao_centeio" not in r["state"]["itens"],
                  "comer o pão: +30 de vigor (20 -> 50) e o pão sai da bolsa")
            r = srv.post("/api/acao", {"acao": "usar", "item": "cartao_guilda"})
            check(r["ok"] is False, "o cartão da Guilda não é consumível")
            r = srv.post("/api/acao", {"acao": "aceitar", "missao": "mapa_capital", "npc": "luna"})
            check(r["ok"], "Luna oferece o mapa depois da lenha")
            for m in ("Praca", "Guilda", "Templo", "Jardim", "Mercado"):
                r = srv.post("/api/acao", {"acao": "visitar", "marco": m})
            check(r["state"]["missoes"]["mapa_capital"]["etapa"] == 0, "faltando o Portão Sul, a etapa de explorar continua")
            r = srv.post("/api/acao", {"acao": "visitar", "marco": "PortaoSul"})
            check(r["state"]["missoes"]["mapa_capital"]["etapa"] == 1, "6 marcos visitados: etapa avança")
            prox_antes = disk(story)["proximidade"]
            r = srv.post("/api/acao", {"acao": "concluir", "missao": "mapa_capital", "npc": "luna"})
            check(r["ok"] and r["state"]["itens"].get("mapa_luna") == 1 and abs(r["state"]["proximidade"] - prox_antes - 0.05) < 1e-9,
                  "mapa entregue pela Luna e a proximidade sobe exatamente um passo slow-burn (0.05)")

            print("=== 3. Chat com contexto de NPC ===")
            antes = disk(story)
            frames = srv.chat_ctx("Oi, Sera. Tem chá pra chuva?", npc="sera", cena={"local": "Botica da Sera", "hora": "10:00", "clima": "garoa",
                                                                                     "presentes": [{"id": "sera", "atividade": "rotulando frascos"}]})
            done = frames[-1]
            check(done["type"] == "done" and "Sera" in done["narration"], "narração focada na Sera")
            depois = disk(story)
            check(all(depois[k] == antes[k] for k in ("proximidade", "confianca", "tensao", "humor")), "Luna ausente: relação e humor dela intocados")
            check("Sera" in depois["npcs"], "atitude da Sera gravada nos NPCs")

            print("=== 3b. Relógio e clima do mundo vão para o save ===")
            st = srv.get("/api/state")["state"]
            check(st["mundo"]["hora"] == 9.0 and st["mundo"]["chuva"] == 0.0, "jornada nova começa de manhã e sem chuva (antes: 18h30 com chuva)")
            srv.post("/api/acao", {"acao": "sincronizar_status", "status": {"vigor": 50, "calor": 60},
                                   "mundo": {"hora": 21.75, "dia": 4, "chuva": 0.6, "alvo": 1.0}})
            # Controle negativo: sincronizar só o corpo não pode mexer no relógio salvo
            srv.post("/api/acao", {"acao": "sincronizar_status", "status": {"vigor": 50, "calor": 60}})
            check(disk(story)["jogo"]["mundo"] == {"hora": 21.75, "dia": 4, "chuva": 0.6, "alvo": 1.0}, "noite chuvosa do dia 4 gravada no disco")

        print("=== 4. Persistência após reiniciar o processo ===")
        with LiveServer(story) as srv:
            st = srv.get("/api/state")["state"]
            check(st["itens"].get("cartao_guilda") == 1 and st["itens"].get("mapa_luna") == 1 and st["cobre"] == 1, "bolsa e carteira sobrevivem ao reinício")
            check(st["missoes"]["ervas_sera"]["estado"] == "concluida" and "erva_3" in st["coletados"], "missões e coletáveis sobrevivem ao reinício")
            check(st["mundo"]["hora"] == 21.75 and st["mundo"]["dia"] == 4, "a hora do mundo sobrevive ao reinício (21h45 do dia 4)")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _chat_ctx(self, message: str, npc: str, cena: dict) -> list[dict]:
    import urllib.request
    payload = {"message": message, "motor": "teste", "npc": npc, "cena": cena}
    req = urllib.request.Request(f"{self.base}/api/chat", data=json.dumps(payload).encode("utf-8"), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read().decode("utf-8")
    out = []
    for block in raw.split("\n\n"):
        line = block.strip()
        if line.startswith("data:") and line[5:].strip() != "[DONE]":
            out.append(json.loads(line[5:].strip()))
    return out


LiveServer.chat_ctx = _chat_ctx

if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass
    run()
    print("\n>>> ESTADO DE JOGO V2 VALIDADO DE PONTA A PONTA (com migração do save v1) <<<")
