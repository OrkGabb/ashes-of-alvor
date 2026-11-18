#!/usr/bin/env python3
"""
Combate autoritativo (jogo.EstadoJogo + /api/acao) de ponta a ponta, sempre numa cópia temporária da história.

1. Migração de save: um relacao.json v2 REAL do jogador, de antes do combate (sem "equipado"/"abates"), carregado
   pelo processo real do server.py. Bolsa, missões, marcos e cobre antigos sobrevivem; as armas chegam; o jogador
   equipa o cajado e, após reiniciar o servidor, o cajado continua em mãos (o kit não é dado de novo).
   Controles negativos (pelo caminho real de carga, em processo): kit dado a cada carga reseta a arma escolhida;
   sem a migração do kit, o save antigo fica com "espada equipada" que não está na bolsa.
2. Pelo HTTP: equipar, poção de vida/mana, abater (anti-spam por spawn, treino e tipo desconhecido ignorados,
   abates antes de aceitar não contam), contrato de caça até concluir e pagar, derrota (respawn, penalidade,
   itens protegidos) e tudo persistido após reiniciar.
3. Em processo (RNG e relógio injetados): limite de empilhamento nos drops, recarga do spawn vence com o tempo,
   lista de spawns limitada, penalidade com teto, drop de minério NÃO pula a etapa "recuperar" da patrulha
   (controle negativo: a regra antiga de coleta pulava), narrador recebe arma e abates.

Execução:
  python test_combate.py
"""
from __future__ import annotations

import copy
import json
import random
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

import jogo
import play
from test_server_live import SOURCE_STORY, LiveServer

FAILS: list[str] = []

# Retrato do relacao.json real do jogador (historias/Isekai/luna/relacao.json) antes do combate: v2 sem equipado/abates
SAVE_V2_PRE_COMBATE: dict[str, Any] = {
    "proximidade": 0.2, "confianca": 0.2, "tensao": 0.05, "humor": "curiosa e irônica",
    "intencao": "ver até onde o Desperto vai", "npcs": {"Bram": "satisfeito com a lenha entregue"},
    "lembrancas": ["Registrou-se na Guilda dos Aventureiros com a Maren e recebeu o Cartão de Aventureiro Rank F."],
    "tarefa": "Explore a capital", "turnos": 12, "historico": [],
    "jogo": {
        "versao": 2, "cobre": 6,
        "inventario": {"amuleto_trevo": 1, "pao_mel": 2, "pao_centeio": 2, "cartao_guilda": 1, "mapa_luna": 1, "pocao_vigor": 1},
        "missoes": {"lenha_bram": {"estado": "concluida", "etapa": 2}, "registro_guilda": {"estado": "concluida", "etapa": 1},
                    "gato_tilly": {"estado": "concluida", "etapa": 2}, "paes_guarda": {"estado": "concluida", "etapa": 1},
                    "mapa_capital": {"estado": "concluida", "etapa": 2}},
        "coletados": ["lenha_patio", "bolinho", "bau_ruinas_loot"],
        "marcos": ["Praca", "Guilda", "Mercado", "PortaoSul", "Jardim", "Templo", "EstradaVelha", "Acampamento", "MataCinzenta", "RuinasMarco"],
        "desbloqueios": {"ensopado": True},
        "confianca_npc": {"bram": 0.4, "tilly": 0.45, "rosa": 0.4, "aldric": 0.3, "maren": 0.3},
        "status": {"vigor": 61.0, "calor": 95.0},
        "mundo": {"hora": 3.492, "dia": 3, "chuva": 0.0, "alvo": 0.0},
    },
}
BOLSA_ANTIGA = SAVE_V2_PRE_COMBATE["jogo"]["inventario"]


def check(cond: bool, msg: str) -> None:
    print(f"  [{'OK' if cond else 'FALHOU'}] {msg}")
    if not cond:
        FAILS.append(msg)


def new_story(tmp: Path, save: dict[str, Any]) -> Path:
    story = tmp / "Isekai"
    shutil.copytree(SOURCE_STORY, story, ignore=shutil.ignore_patterns("sessao-*.txt", "*.bak"))
    (story / "luna" / "historico.json").write_text("[]", encoding="utf-8")
    (story / "luna" / "relacao.json").write_text(json.dumps(save, ensure_ascii=False), encoding="utf-8")
    return story


def disk(story: Path) -> dict[str, Any]:
    return json.loads((story / "luna" / "relacao.json").read_text(encoding="utf-8"))["jogo"]


def preservou_save_antigo(st: dict[str, Any]) -> bool:
    """O que só o save antigo preservado responde."""
    return (
        all(st["itens"].get(k) == v for k, v in BOLSA_ANTIGA.items())
        and st["cobre"] == 6
        and all(st["missoes"].get(q, {}).get("estado") == "concluida" for q in SAVE_V2_PRE_COMBATE["jogo"]["missoes"])
        and "RuinasMarco" in st["marcos"] and abs(st["confianca_npc"].get("maren", 0) - 0.3) < 1e-9
    )


def carregar(path: Path, save: dict[str, Any] | None = None, **kw: Any) -> jogo.EstadoJogo:
    """Caminho real de carga: play.Relacao lê o arquivo do disco e jogo.EstadoJogo migra/garante a estrutura."""
    if save is not None:
        path.write_text(json.dumps(save, ensure_ascii=False), encoding="utf-8")
    return jogo.EstadoJogo(play.Relacao(path), "", **kw)


class RngFixo(random.Random):
    """random() sempre devolve `valor` (0.0 = todo drop acontece, 0.999 = nenhum); randint pega o mínimo."""

    def __init__(self, valor: float) -> None:
        super().__init__(0)
        self.valor = valor

    def random(self) -> float:
        return self.valor

    def randint(self, a: int, b: int) -> int:
        return a


class Relogio:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def parte_migracao(tmp: Path) -> None:
    print("=== 1. Save v2 real de antes do combate, pelo processo real do servidor ===")
    story = new_story(tmp / "mig", SAVE_V2_PRE_COMBATE)
    with LiveServer(story) as srv:
        st = srv.get("/api/state")["state"]
        check(preservou_save_antigo(st), "bolsa, cobre (6), missões concluídas, marcos e confiança antigos sobrevivem")
        check(st["itens"].get("espada_curta") == 1 and st["itens"].get("cajado_aprendiz") == 1 and st["equipado"] == {"arma": "espada_curta"},
              "o save antigo recebe espada e cajado, com a espada em mãos")
        check(st["abates"] == {} and st["status"].get("vida") == 100 and st["status"].get("mana") == 60 and st["status"]["vigor"] == 61.0,
              "abates zerados; vida/mana entram no status sem mexer no vigor salvo (61)")
        r = srv.post("/api/acao", {"acao": "equipar", "item": "cajado_aprendiz"})
        check(r["ok"] and r["state"]["equipado"]["arma"] == "cajado_aprendiz", "jogador troca para o cajado")
    on = disk(story)
    check(on["equipado"] == {"arma": "cajado_aprendiz"} and on["inventario"]["espada_curta"] == 1, "relacao.json gravado com o equipamento novo")
    with LiveServer(story) as srv:
        st = srv.get("/api/state")["state"]
        check(st["equipado"]["arma"] == "cajado_aprendiz" and preservou_save_antigo(st),
              "após reiniciar, o cajado continua em mãos (o kit inicial não foi dado de novo)")

    # Controles negativos pelo mesmo caminho de carga (arquivo -> play.Relacao -> EstadoJogo)
    orig = jogo.EstadoJogo.__dict__["_precisa_kit"]  # o staticmethod em si (não a função desembrulhada)
    try:
        jogo.EstadoJogo._precisa_kit = staticmethod(lambda atual: True)  # type: ignore[method-assign]
        neg_path = tmp / "neg_sempre.json"
        e = carregar(neg_path, copy.deepcopy(SAVE_V2_PRE_COMBATE))
        e.equipar("cajado_aprendiz")
        e2 = carregar(neg_path)
        check(e2.d["equipado"]["arma"] != "cajado_aprendiz",
              "CONTROLE NEGATIVO: dar o kit a cada carga desfaz a arma escolhida (o teste acima detecta re-entrega)")
        jogo.EstadoJogo._precisa_kit = staticmethod(lambda atual: False)  # type: ignore[method-assign]
        e3 = carregar(tmp / "neg_nunca.json", copy.deepcopy(SAVE_V2_PRE_COMBATE))
        pub = e3.publico()
        check(not (pub["itens"].get("espada_curta") == 1 and pub["itens"].get("cajado_aprendiz") == 1),
              "CONTROLE NEGATIVO: sem a migração do kit, o save antigo fica sem as armas (só o preenchimento genérico)")
    finally:
        jogo.EstadoJogo._precisa_kit = orig  # type: ignore[method-assign]


def parte_http(tmp: Path) -> None:
    print("=== 2. Combate pelo /api/acao (processo real) ===")
    story = new_story(tmp / "http", SAVE_V2_PRE_COMBATE)
    with LiveServer(story) as srv:
        acao = lambda nome, **kw: srv.post("/api/acao", {"acao": nome, **kw})  # noqa: E731

        r = acao("equipar", item="pao_mel")
        check(r["ok"] is False and r["state"]["equipado"]["arma"] == "espada_curta", "pão não se equipa (arma continua a espada)")
        r = acao("equipar", item="cajado_aprendiz")
        check(r["ok"] and r["state"]["equipado"]["arma"] == "cajado_aprendiz" and r["event"] == "equipado", "equipar o cajado")

        acao("sincronizar_status", status={"vida": 30, "mana": 10, "vigor": 40, "calor": 80})
        r = acao("comprar", item="pocao_vida", npc="sera")
        check(r["ok"] and r["state"]["cobre"] == 0 and r["state"]["itens"].get("pocao_vida") == 1, "poção de vida comprada da Sera (6 cobres)")
        r = acao("usar", item="pocao_vida")
        check(r["ok"] and r["effect"].get("vida") == 45 and r["state"]["status"]["vida"] == 75 and "pocao_vida" not in r["state"]["itens"],
              "poção de vida: 30 -> 75 de vida e sai da bolsa")
        r = acao("usar", item="pocao_mana")
        check(r["ok"] is False and r["state"]["status"]["mana"] == 10, "sem poção de mana na bolsa, a mana não muda")

        print("--- abates ---")
        r = acao("abater", inimigo="slime", spawn="slime_ribeirao_1")
        check(r["ok"] and r["state"]["abates"].get("slime") == 1 and r["state"]["cobre"] == r["cobre"] and 0 <= r["cobre"] <= 2,
              f"slime abatido antes de qualquer contrato (+{r.get('cobre')} cobre, resposta traz 'cobre')")
        check(set(r["gained"]) <= {"essencia_slime", "minerio_alvor"} and r["message"].startswith("Slime do Ribeirão derrotado!"),
              f"drops sorteados no servidor só da tabela do slime: {r['gained']} — \"{r['message']}\"")
        cobre = r["state"]["cobre"]
        r = acao("abater", inimigo="slime", spawn="slime_ribeirao_1")
        check(r["ok"] is False and r["event"] == "abate_repetido" and r["state"]["abates"]["slime"] == 1 and r["state"]["cobre"] == cobre,
              "spam do mesmo spawn: recusado, sem abate nem cobre")
        r = acao("abater", inimigo="boneco", spawn="boneco_treino_1")
        check(r["ok"] is False and "boneco" not in r["state"]["abates"], "boneco de treino nunca conta")
        r = acao("abater", inimigo="dragao", spawn="dragao_1")
        check(r["ok"] is False and "dragao" not in r["state"]["abates"], "tipo desconhecido é ignorado")
        r = acao("abater", inimigo="javali", spawn="../../relacao")
        check(r["ok"] is False and "javali" not in r["state"]["abates"], "spawn id fora do padrão é recusado")

        print("--- contrato de caça ---")
        r = acao("aceitar", missao="caca_slimes", npc="maren")
        check(r["ok"] and r["state"]["missoes"]["caca_slimes"]["progresso"] == {"atual": 0, "total": 5}
              and r["state"]["missoes"]["caca_slimes"]["texto"].endswith("(0/5)"), "slime abatido ANTES de aceitar não conta (0/5)")
        check("caca_lobos" not in r["state"]["missoes_disponiveis"].get("maren", []), "contrato dos lobos exige o dos javalis antes")
        r = acao("aceitar", missao="caca_javalis", npc="maren")
        check(r["ok"], "contrato dos javalis aceito com a Maren")
        r = acao("abater", inimigo="lobo", spawn="lobo_mata_1")
        check(r["state"]["missoes"]["caca_javalis"]["progresso"]["atual"] == 0, "lobo abatido não avança contrato de javali")
        for i in range(1, 4):
            r = acao("abater", inimigo="javali", spawn=f"javali_estrada_{i}")
        q = r["state"]["missoes"]["caca_javalis"]
        check(q["etapa"] == 0 and q["texto"].endswith("(3/4)") and "(3/4)" in r["message"], f"3 javalis: tracker \"{q['texto']}\"")
        r = acao("concluir", missao="caca_javalis", npc="maren")
        check(r["ok"] is False and r["event"] == "etapa_automatica" and r["state"]["missoes"]["caca_javalis"]["estado"] == "ativa",
              "relatar com 3/4 é recusado")
        r = acao("abater", inimigo="javali", spawn="javali_estrada_4")
        q = r["state"]["missoes"]["caca_javalis"]
        check(q["etapa"] == 1 and q["objetivo"] == {"tipo": "falar", "npc": "maren"} and "etapa cumprida" in r["message"],
              "4º javali cumpre a caça: próxima etapa é relatar à Maren")
        antes = r["state"]
        r = acao("concluir", missao="caca_javalis", npc="maren")
        s = r["state"]
        check(r["ok"] and s["missoes"]["caca_javalis"]["estado"] == "concluida" and s["cobre"] == antes["cobre"] + 12
              and s["itens"].get("pocao_vida", 0) == antes["itens"].get("pocao_vida", 0) + 1
              and abs(s["confianca_npc"]["maren"] - 0.4) < 1e-9, "contrato pago: +12 cobres, +1 poção de vida, Maren +10%")
        check("caca_lobos" in s["missoes_disponiveis"].get("maren", []), "com os javalis cumpridos, a Maren oferece os lobos")
        check(s["abates"] == {"slime": 1, "lobo": 1, "javali": 4}, f"abates contados por tipo: {s['abates']}")

        print("--- derrota ---")
        acao("sincronizar_status", status={"vida": 0, "mana": 3, "vigor": 0})
        bolsa = dict(s["itens"])
        cobre = s["cobre"]
        r = acao("derrota", local="MataCinzenta", extramuros=True)
        s = r["state"]
        perda = min(20, int(cobre * 0.1))
        check(r["ok"] and r["respawn"] == "acampamento", "derrota fora da muralha com o Acampamento conhecido: acorda no acampamento")
        check(s["status"]["vida"] == 50 and s["status"]["mana"] == 30 and s["status"]["vigor"] == 50, "vida 50%, mana 50%, vigor 50")
        check(s["cobre"] == cobre - perda and r["cobre_perdido"] == perda, f"penalidade de 10% do cobre ({cobre} -> {s['cobre']})")
        check(s["itens"] == bolsa and s["itens"].get("cartao_guilda") == 1 and s["itens"].get("cajado_aprendiz") == 1,
              "nenhum item sai da bolsa (cartão, mapa, armas, poções)")
        r = acao("derrota", local="Praca", extramuros=False)
        check(r["respawn"] == "cidade", "derrota dentro da muralha: enfermaria da cidade")
        final = r["state"]

    print("=== 2b. Persistência após reiniciar ===")
    with LiveServer(story) as srv:
        st = srv.get("/api/state")["state"]
        check(st["abates"] == final["abates"] and st["equipado"]["arma"] == "cajado_aprendiz" and st["cobre"] == final["cobre"],
              "abates, arma equipada e cobre voltam do disco")
        check(st["missoes"]["caca_javalis"]["estado"] == "concluida" and st["missoes"]["caca_slimes"]["texto"].endswith("(0/5)")
              and st["itens"] == final["itens"], "contratos (concluído e em andamento) e bolsa voltam do disco")
        r = srv.post("/api/acao", {"acao": "abater", "inimigo": "slime", "spawn": "slime_ribeirao_2"})
        check(r["state"]["missoes"]["caca_slimes"]["texto"].endswith("(1/5)"), "progresso do contrato continua contando após reiniciar")


def parte_processo(tmp: Path) -> None:
    print("=== 3. Regras em processo (RNG e relógio injetados) ===")
    relogio = Relogio()
    e = carregar(tmp / "p1.json", copy.deepcopy(SAVE_V2_PRE_COMBATE), rng=RngFixo(0.0), relogio=relogio)
    e.d["inventario"]["presa_javali"] = 20
    r = e.abater("javali", "javali_a")
    check(r.ok and "presa_javali" not in r.itens_ganhos and e.qtd("presa_javali") == 20, "bolsa cheia de presas (20/20): o drop não estoura o limite")
    e.d["inventario"]["presa_javali"] = 3
    r = e.abater("javali", "javali_b")
    check(r.itens_ganhos.get("presa_javali") == 1 and e.qtd("presa_javali") == 4, "controle: com espaço a presa cai")
    relogio.t += 29.0
    check(e.abater("javali", "javali_b").ok is False, "29 s depois o mesmo spawn ainda está em recarga (50% de 60 s)")
    relogio.t += 2.0
    check(e.abater("javali", "javali_b").ok is True, "31 s depois o spawn rende de novo")
    for i in range(400):
        e.abater("slime", f"slime_x{i}")
    check(len(e._spawns_abatidos) <= jogo.MAX_SPAWNS_GUARDADOS, f"ids de spawn guardados limitados ({len(e._spawns_abatidos)})")
    nada = carregar(tmp / "p1b.json", copy.deepcopy(SAVE_V2_PRE_COMBATE), rng=RngFixo(0.999))
    r = nada.abater("guardiao", "guardiao_ruinas")
    check(r.ok and r.itens_ganhos == {"nucleo_runico": 1} and r.extra["cobre"] == 18, "chance 1.0 sempre cai; as demais não (RNG injetado)")

    rico = carregar(tmp / "p2.json", copy.deepcopy(SAVE_V2_PRE_COMBATE))
    rico.d["cobre"] = 500
    r = rico.derrota("Ruinas", True)
    check(r.extra["cobre_perdido"] == 20 and rico.cobre == 480, "penalidade com teto: 500 cobres perdem 20, não 50")
    sem_acamp = copy.deepcopy(SAVE_V2_PRE_COMBATE)
    sem_acamp["jogo"]["marcos"] = ["Praca"]
    check(carregar(tmp / "p3.json", sem_acamp).derrota("EstradaVelha", True).extra["respawn"] == "cidade",
          "fora da muralha sem conhecer o Acampamento: volta para a cidade")
    morto = copy.deepcopy(SAVE_V2_PRE_COMBATE)
    morto["jogo"]["status"]["vida"] = 0
    check(carregar(tmp / "p4.json", morto).d["status"]["vida"] == 50, "save gravado com vida 0 não carrega desmaiado")

    print("--- drop de minério x etapa 'recuperar' da patrulha ---")
    def patrulha_em_recuperar(path: Path) -> jogo.EstadoJogo:
        s = copy.deepcopy(SAVE_V2_PRE_COMBATE)
        s["jogo"]["missoes"]["patrulha_sul"] = {"estado": "ativa", "etapa": 1}
        return carregar(path, s, rng=RngFixo(0.0))

    e = patrulha_em_recuperar(tmp / "p5.json")
    r = e.abater("slime", "slime_ribeirao_9")
    check(r.itens_ganhos.get("minerio_alvor") == 1 and e.missao("patrulha_sul")["etapa"] == 1,
          "slime derruba Cristal Bruto, mas a etapa 'recuperar a carga da carroça' continua")
    r = e.coletar("suprimentos_estrada")
    check(r.ok and e.missao("patrulha_sul")["etapa"] == 2, "a carga da carroça continua coletável e cumpre a etapa")
    r = e.concluir("patrulha_sul", "aldric")
    check(r.ok and e.missao("patrulha_sul")["estado"] == "concluida" and e.qtd("minerio_alvor") == 1, "entrega ao Aldric (fica o cristal do slime)")
    orig = jogo.EstadoJogo._coleta_cumprida
    try:
        jogo.EstadoJogo._coleta_cumprida = lambda self, qid, et: self.qtd(et["objetivo"]["item"]) >= int(et["objetivo"].get("qtd", 1))  # type: ignore[method-assign]
        neg = patrulha_em_recuperar(tmp / "p6.json")
        neg.abater("slime", "slime_ribeirao_9")
        check(neg.missao("patrulha_sul")["etapa"] == 2 and neg.coletar("suprimentos_estrada").ok is False,
              "CONTROLE NEGATIVO: com a regra antiga (só bolsa) o drop pula a etapa e a carga da carroça some do jogo")
    finally:
        jogo.EstadoJogo._coleta_cumprida = orig  # type: ignore[method-assign]
    e = patrulha_em_recuperar(tmp / "p7.json")
    e.d["inventario"]["erva_brasa"] = 3
    e.d["missoes"]["ervas_sera"] = {"estado": "ativa", "etapa": 0}
    e.coletar("erva_1")
    check(e.missao("ervas_sera")["etapa"] == 0, "mesma regra nas ervas: só ramos colhidos do Jardim contam")

    print("--- narrador ---")
    e = carregar(tmp / "p8.json", copy.deepcopy(SAVE_V2_PRE_COMBATE), rng=RngFixo(0.999))
    e.aceitar("caca_lobos", "maren")  # indisponível (exige javalis): não pode aparecer
    e.aceitar("caca_javalis", "maren")
    e.abater("javali", "javali_estrada_1")
    bloco = e.bloco_narrador()
    check("Espada Curta de Aço" in bloco and "Javali Selvagem x1" in bloco and "(1/4)" in bloco and "Lobos" not in bloco,
          "bloco do narrador traz a arma em mãos, os abates e o contador do contrato")


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="alvor_combate_"))
    try:
        parte_migracao(tmp)
        parte_http(tmp)
        parte_processo(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if FAILS:
        print(f"\nFALHOU ({len(FAILS)}):")
        for f in FAILS:
            print("  -", f)
        return 1
    print("\nOK: combate autoritativo, contratos de caça, derrota e migração do save validados (com controles negativos)")
    return 0


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass
    sys.exit(main())
