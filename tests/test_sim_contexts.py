"""Offline tests for evidence-derived scenario contexts (app/sim/contexts.py)
and their integration into loop.run_loop / eval.final_eval.

ZERO network: app.llm.client.generate is monkeypatched throughout (same
pattern as tests/test_sim.py). Derivation must produce contexts whose names
flow through the loop's train rotation and final_eval's held-out eval.
Run:  python -m pytest tests/test_sim_contexts.py -v   (from project root)
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.llm import client as llm_client
from app.models import Persona
from app.sim import contexts as ctx_mod
from app.sim import eval as sim_eval
from app.sim import loop as loop_mod
from app.sim.market import simulate
from app.sim.truth import sample_truth

BASELINE_HOUR = 21


# ------------------------------------------------------------------ helpers

def card(ctype: str, claim: str) -> dict:
    return {"id": f"e_{ctype}_{abs(hash(claim)) % 999}", "type": ctype,
            "claim": claim, "source_url": "https://x.test/1",
            "source_label": "t", "quote": None}


# The "Luminal" style evidence set: an AI-inference startup — events, weather,
# a competitor report. NO football calendar anywhere.
STARTUP_EVIDENCE = [
    card("event", "Product demo day at the convention center October 18"),
    card("event", "City tech mixer at the coworking space first Friday"),
    card("weather", "heavy rain expected Saturday"),
    card("competitor", "Rival inference startup launched a free tier downtown"),
]

CANNED_CONTEXTS = {"contexts": [
    {"name": "product_demo_day", "signal": "Product demo day at the convention "
     "center October 18 — amplifies traffic and the promo/launch lever",
     "multiplier_by_param": {"game_day": 1.8, "late_night": 1.0, "price": 1.0,
                             "traffic": 2.2}, "occurs_in": "train"},
    {"name": "coworking_mixer", "signal": "City tech mixer first Friday — "
     "amplifies the late-hours lever", "multiplier_by_param": {"traffic": 1.3,
     "late_night": 2.0}, "occurs_in": "train"},
    {"name": "rain_saturday", "signal": "heavy rain expected Saturday — cuts "
     "walk-in traffic", "multiplier_by_param": {"traffic": 0.7},
     "occurs_in": "train"},
    {"name": "rival_free_tier", "signal": "Rival inference startup launched a "
     "free tier downtown — pricing pressure, held-out", "multiplier_by_param":
     {"price": 1.8, "traffic": 0.8}, "occurs_in": "test"},
]}


class _FakeCtxLLM:
    def __init__(self):
        self.generate_calls = 0

    async def generate(self, messages, **kwargs):
        self.generate_calls += 1
        return json.dumps(CANNED_CONTEXTS)


async def _no_llm(*args, **kwargs):
    return None


def _fallback_ranges(segments):
    return {"segments": list(segments), "knobs": ["late_night_affinity"],
            "ranges": {
                "base_visits_wk_total": {"min": 200.0, "max": 300.0},
                "price_elasticity": {"min": 0.008, "max": 0.012},
                "promo_amplitude": {"min": 0.2, "max": 0.3},
                "late_hours_labor_cost": {"min": 40.0, "max": 90.0},
                "avg_ticket": {"min": 12.0, "max": 18.0},
                "late_night_affinity": {"min": 0.1, "max": 0.4},
                "appointment_density": {"min": 0.05, "max": 0.3},
            }}


def hand_truth_1seg(*, promo_amp: float = 0.0, game_day: float = 0.0) -> dict:
    """Round-number truth: base=100/wk, ticket $10, elasticity 0.01 per 1%,
    labor $20 per late hour, late amp 0.5, cliff hour 25."""
    return {
        "version": 1, "seed": 0, "segments": ["students"],
        "knob": "late_night_affinity",
        "global": {"price_elasticity": 0.01, "promo_amplitude": promo_amp,
                   "late_hours_labor_cost": 20.0, "avg_ticket": 10.0,
                   "noise_scale": 0.06},
        "late_cliff_hour": 25, "base_closing_hour": 21,
        "segments_params": {"students": {
            "base_visits_wk": 100.0, "price_elasticity_scale": 1.0,
            "late_gain_amp": 0.5, "promo_amp": promo_amp,
            "ctx": {"game_day": game_day, "finals_week": 0.0, "summer": 0.0}}},
    }


def decision(pct, hour, promo):
    from app.models import SimDecision
    return SimDecision(price_change_pct=pct, closing_hour=hour, promo=promo)


def _personas(*segments):
    if not segments:
        segments = ("developers", "investors")
    return [Persona(id=f"p{i}", segment=s, name=f"Persona {s}",
                    profile="x", source_review_ids=[], weight=1.0)
            for i, s in enumerate(segments, 1)]


# --------------------------------------------------- derivation (LLM path)

def test_derive_contexts_one_llm_call_and_shape(monkeypatch):
    fake = _FakeCtxLLM()
    monkeypatch.setattr(ctx_mod.llm_client, "generate", fake.generate)
    override = asyncio.run(ctx_mod.derive_contexts(
        STARTUP_EVIDENCE, [], "startup", 11))

    assert fake.generate_calls == 1          # ONE cheap LLM call
    assert override["source"] == "llm"
    assert override["business_class"] == "startup"
    train, test = override["train"], override["test"]
    assert [c["name"] for c in train] == \
        ["product_demo_day", "coworking_mixer", "rain_saturday"]
    assert [c["name"] for c in test] == ["rival_free_tier"]
    assert all(c["occurs_in"] == "train" for c in train)
    assert all(c["occurs_in"] == "test" for c in test)
    for c in train + test:                   # every param present, in band
        mbp = c["multiplier_by_param"]
        assert set(mbp) == {"game_day", "late_night", "price", "traffic"}
        gd_lo, gd_hi, other_lo = 0.0, 3.0, 0.5
        assert gd_lo <= mbp["game_day"] <= gd_hi
        for p in ("late_night", "price", "traffic"):
            assert other_lo <= mbp[p] <= 3.0
    # no football leakage anywhere in the derived set
    assert not ({"game_day", "finals_week", "summer", "playoff_weekend"}
                & {c["name"] for c in train + test})


def test_llm_garbage_degrades_to_fallback(monkeypatch):
    async def garbage(*a, **k):
        return "not json at all"
    monkeypatch.setattr(ctx_mod.llm_client, "generate", garbage)
    override = asyncio.run(ctx_mod.derive_contexts(STARTUP_EVIDENCE, [],
                                                   "startup", 3))
    assert override["source"] == "fallback"
    # fallback event mapping: 1.5x demand contexts still DERIVED from evidence
    assert len([c for c in override["train"]
                if c["multiplier_by_param"]["traffic"] == 1.5]) == 2


# ------------------------------------------------- derivation (fallback path)

def test_fallback_zero_evidence_zero_llm(monkeypatch):
    monkeypatch.setattr(ctx_mod.llm_client, "generate", _no_llm)
    local = asyncio.run(ctx_mod.derive_contexts([], [], "local_consumer", 3))
    assert local["source"] == "fallback"
    # zero evidence: the classic hardcoded set, demoted to fallback contexts
    assert [c["name"] for c in local["train"]] == \
        ["game_day", "finals_week", "summer"]
    assert [c["name"] for c in local["test"]] == \
        ["playoff_weekend", "new_competitor"]

    startup = asyncio.run(ctx_mod.derive_contexts([], [], "startup", 3))
    # the point of the fix: a startup's empty evidence yields NO football set
    assert startup["train"] == [] and startup["test"] == []
    assert "football" not in json.dumps(startup)

    # loop still runs with the empty-override (pure-degrade) shape
    truth = sample_truth(_fallback_ranges(["developers"]), seed=2)
    rows = asyncio.run(loop_mod.run_loop(
        "startup", _personas("developers"), [], "q", truth, rounds=2,
        contexts_override=startup))
    assert len(rows) == 3 and rows[-1].round == 2


def test_fallback_mapping_from_evidence(monkeypatch):
    monkeypatch.setattr(ctx_mod.llm_client, "generate", _no_llm)
    override = asyncio.run(ctx_mod.derive_contexts(STARTUP_EVIDENCE, [],
                                                   "startup", 3))
    train, test = override["train"], override["test"]
    # events -> 1.5x demand contexts
    ev = [c for c in train if c["multiplier_by_param"]["traffic"] == 1.5
          and c["multiplier_by_param"]["game_day"] == 1.5]
    assert len(ev) == 2
    # weather -> 0.7x late-night
    wt = [c for c in train if c["multiplier_by_param"]["late_night"] == 0.7]
    assert len(wt) == 1 and "rain" in wt[0]["name"]
    # competitor card -> synthetic new_competitor as held-out test context
    assert [c["name"] for c in test] == ["new_competitor"]
    assert test[0]["multiplier_by_param"]["traffic"] == 0.85
    # tailored evidence, no football: classic set must NOT appear for startup
    assert not ({"game_day", "finals_week", "summer"}
                & {c["name"] for c in train})
    assert "playoff_weekend" not in {c["name"] for c in test}

    # local_consumer gets the demoted classic set appended as well
    lc = asyncio.run(ctx_mod.derive_contexts(STARTUP_EVIDENCE, [],
                                             "local_consumer", 3))
    names = [c["name"] for c in lc["train"]]
    assert names[-3:] == ["game_day", "finals_week", "summer"]
    assert [c["name"] for c in lc["test"]] == \
        ["new_competitor", "playoff_weekend"]


def test_determinism_same_evidence_same_seed(monkeypatch):
    fake = _FakeCtxLLM()
    monkeypatch.setattr(ctx_mod.llm_client, "generate", fake.generate)
    a = asyncio.run(ctx_mod.derive_contexts(STARTUP_EVIDENCE, [], "startup", 42))
    b = asyncio.run(ctx_mod.derive_contexts(STARTUP_EVIDENCE, [], "startup", 42))
    assert a == b and [c["name"] for c in a["train"]] == [c["name"] for c in b["train"]]

    monkeypatch.setattr(ctx_mod.llm_client, "generate", _no_llm)
    f1 = asyncio.run(ctx_mod.derive_contexts(STARTUP_EVIDENCE, [], "startup", 42))
    f2 = asyncio.run(ctx_mod.derive_contexts(STARTUP_EVIDENCE, [], "startup", 42))
    assert f1 == f2


# ---------------------------------------------------------- market mechanics

def test_market_executes_derived_contexts_hand_checked():
    truth = hand_truth_1seg(promo_amp=0.3, game_day=0.4)
    ctxs = {"conf": ctx_mod._mk_ctx("conf", "surge", "train",
                                    traffic=1.5),            # scalar traffic
            "price_wary": ctx_mod._mk_ctx("price_wary", "s", "train",
                                          price=2.0),
            "late_party": ctx_mod._mk_ctx("late_party", "s", "train",
                                          late_night=2.0),
            "promo_surge": ctx_mod._mk_ctx("promo_surge", "s", "train",
                                           game_day=2.0)}
    # traffic 1.5x: 150 visits * $10 (no labor at hour 21)
    out = simulate(decision(0, 21, "none"), "conf", truth, contexts=ctxs)
    assert abs(out.revenue - 1500.0) < 1e-6
    # price mult 2.0 with +10%: elas 0.01->0.02, price_eff 0.8 -> 80 visits
    # revenue 80 * 10 * 1.1 = 880
    out = simulate(decision(10, 21, "none"), "price_wary", truth, contexts=ctxs)
    assert abs(out.revenue - 880.0) < 1e-6
    # late_night 2.0 at hour 25 (frac 0.35): 1 + 0.5*2*0.35 = 1.35 -> 135
    # visits * 10 - 4*20 labor = 1270
    out = simulate(decision(0, 25, "none"), "late_party", truth, contexts=ctxs)
    assert abs(out.revenue - 1270.0) < 1e-6
    # game_day 2.0 scales the latent surge 0.4: ctx_eff 1.8 -> 180 visits
    out = simulate(decision(0, 21, "none"), "promo_surge", truth, contexts=ctxs)
    assert abs(out.revenue - 1800.0) < 1e-6
    # ...and with the big promo, the promo-amp lever scales too:
    # promo_term = 0.3 * (1/(1+0.7)) * 2 = 0.35294 -> 135.294 visits
    out = simulate(decision(0, 21, "game_day_special"), "promo_surge", truth,
                   contexts=ctxs)
    assert abs(out.revenue - 1800.0 * 1.3529411764705883) < 1e-3
    # out-of-band multipliers are clamped (spec band 0.5x-3x)
    clamped = {"wild": ctx_mod._mk_ctx("wild", "s", "train", traffic=10.0)}
    out = simulate(decision(0, 21, "none"), "wild", truth, contexts=clamped)
    assert abs(out.revenue - 3000.0) < 1e-6          # traffic clamped to 3.0
    # unknown derived name degrades to the normal baseline
    assert simulate(decision(0, 21, "none"), "mystery", truth, contexts=ctxs) \
        .revenue == simulate(decision(0, 21, "none"), "normal", truth).revenue
    # a HARDCODED name inside the map keeps its classic rulebook untouched
    assert simulate(decision(0, 21, "none"), "game_day", truth).revenue == \
        simulate(decision(0, 21, "none"), "game_day", truth,
                 contexts={"game_day": ctx_mod._mk_ctx(
                     "game_day", "x", "train", game_day=3.0, traffic=3.0)}
                 ).revenue


# ------------------------------------------------------- loop integration

def test_derived_contexts_flow_through_loop(monkeypatch):
    fake = _FakeCtxLLM()
    monkeypatch.setattr(ctx_mod.llm_client, "generate", fake.generate)
    override = asyncio.run(ctx_mod.derive_contexts(STARTUP_EVIDENCE, [],
                                                   "startup", 11))
    train_names = [c["name"] for c in override["train"]]

    # record the context each scored round simulated
    monkeypatch.setattr(loop_mod, "_seen_ctx", [], raising=False)
    orig_sim = loop_mod.simulate

    def rec_sim(d, ctx, truth, deterministic=True, contexts=None):
        loop_mod._seen_ctx.append(ctx)
        return orig_sim(d, ctx, truth, deterministic=deterministic,
                        contexts=contexts)
    monkeypatch.setattr(loop_mod, "simulate", rec_sim)

    truth = sample_truth(_fallback_ranges(["developers", "investors"]), seed=9)
    rows = asyncio.run(loop_mod.run_loop(
        "startup", _personas(), [], "q", truth, rounds=4,
        contexts_override=override))

    assert len(rows) == 5
    seen = loop_mod._seen_ctx
    assert seen[0] == "normal"                       # round 0 = baseline
    assert set(seen[1:]) <= set(train_names)         # rounds rotate derived ctx
    assert set(seen[1:]) == set(train_names)         # all of them appear
    # regression guard: without the override, everything stays "normal"
    monkeypatch.setattr(loop_mod, "_seen_ctx", [])
    asyncio.run(loop_mod.run_loop(
        "startup", _personas(), [], "q", truth, rounds=4,
        contexts_override=None))
    assert loop_mod._seen_ctx == ["normal"] * 5


def test_final_eval_uses_override_test_contexts(monkeypatch):
    fake = _FakeCtxLLM()
    monkeypatch.setattr(ctx_mod.llm_client, "generate", fake.generate)
    override = asyncio.run(ctx_mod.derive_contexts(STARTUP_EVIDENCE, [],
                                                   "startup", 11))

    truth = sample_truth(_fallback_ranges(["developers"]), seed=9)
    rows = asyncio.run(loop_mod.run_loop(
        "startup", _personas("developers"), [], "q", truth, rounds=2,
        contexts_override=override))

    orig_gb = sim_eval.grid_best
    seen = []

    def rec_gb(ctx, truth_arg, contexts=None):
        seen.append(ctx)
        return orig_gb(ctx, truth_arg, contexts=contexts)
    monkeypatch.setattr(sim_eval, "grid_best", rec_gb)

    test_truths = [sample_truth(_fallback_ranges(["developers"]), 51),
                   sample_truth(_fallback_ranges(["developers"]), 52)]
    result = sim_eval.final_eval(rows, test_truths, contexts_override=override)

    assert result["shifted_context_regret"] is not None
    assert result["baseline_regret"] == rows[0].regret
    assert result["final_regret"] == rows[-1].regret
    # derived test contexts appear in the held-out eval (not the football pair)
    assert "rival_free_tier" in seen
    assert "playoff_weekend" not in seen
    # default (no override) still evaluates the classic held-out pair
    seen.clear()
    result2 = sim_eval.final_eval(rows, test_truths)
    assert result2["shifted_context_regret"] is not None
    assert set(seen) == {"normal", "playoff_weekend", "new_competitor"}


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__, "-v"]))