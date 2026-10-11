"""Offline deterministic tests for the mock-market simulator + loop.

Runs with NO API keys: the loop LLM is replaced by a stateful FAKE client.
Run:  python -m pytest tests/test_sim.py   (or: python tests/test_sim.py)
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.models import Persona, SimDecision
from app.sim.market import (HOUR_GRID, PRICE_GRID, grid_best, regret_of,
                            simulate)
from app.sim import loop as loop_mod
from app.sim.truth import (TRUTH_PATH, calibrate_ranges, load_truth,
                           sample_truth, save_truth)


BASELINE_HOUR = 21


def hand_truth_1seg(*, promo_amp: float = 0.0) -> dict:
    """Single-segment truth with round numbers for hand-checked arithmetic.
    base=100/wk, ticket=$10, elasticity=0.01/1% price, labor=$20 per late hour,
    late gain amp=0.5, cliff at hour 25 (4 extra hours), no context load."""
    return {
        "version": 1, "seed": 0, "segments": ["students"], "knob": "late_night_affinity",
        "global": {"price_elasticity": 0.01, "promo_amplitude": promo_amp,
                   "late_hours_labor_cost": 20.0, "avg_ticket": 10.0,
                   "noise_scale": 0.06},
        "late_cliff_hour": 25, "base_closing_hour": 21,
        "segments_params": {"students": {
            "base_visits_wk": 100.0, "price_elasticity_scale": 1.0,
            "late_gain_amp": 0.5, "promo_amp": promo_amp,
            "ctx": {"game_day": 0.0, "finals_week": 0.0, "summer": 0.0}}},
    }


def decision(pct, hour, promo):
    return SimDecision(price_change_pct=pct, closing_hour=hour, promo=promo)


# ------------------------------------------------------------------ purity

def test_simulate_is_pure():
    truth = sample_truth(_fallback_ranges(["students", "regulars"]), seed=7)
    d = decision(5, 24, "student_deal")
    a = simulate(d, "game_day", truth, deterministic=True)
    b = simulate(d, "game_day", truth, deterministic=True)
    assert a == b
    noisy_a = simulate(d, "game_day", truth, deterministic=False)
    noisy_b = simulate(d, "game_day", truth, deterministic=False)
    assert noisy_a == noisy_b          # same seed'd noise, still reproducible
    sp = truth["segments_params"]["students"]
    assert sp["base_visits_wk"] > 0 and sp["late_gain_amp"] >= 0


def test_simulate_outcome_shape():
    truth = sample_truth(_fallback_ranges(["a", "b"]), seed=3)
    out = simulate(decision(0, 21, "none"), "normal", truth)
    assert set(out.visits_by_segment) == {"a", "b"}
    assert out.revenue > 0 and abs(out.rating_drift) <= 1


# ------------------------------------------------- regret math (hand-checked)

def test_regret_hand_checkable():
    truth = hand_truth_1seg(promo_amp=0.0)  # promo inert -> pure price/hours math
    # (0, 21, none): no effects active -> 100 visits * $10
    zero = simulate(decision(0, 21, "none"), "normal", truth)
    assert abs(zero.revenue - 1000.0) < 1e-9
    # (+10): price_eff = 1 - 0.01*10 = 0.9 -> 90 visits * $10 * 1.1 = 990
    hike = simulate(decision(10, 21, "none"), "normal", truth)
    assert abs(hike.revenue - 990.0) < 1e-9
    # hours: extra=4 (hour 25 == cliff) -> frac 0.35 -> 117.5 visits; labor 4*20
    # revenue 1175 - 80 = 1095, and hour 26 (past cliff) decays: less.
    assert abs(simulate(decision(0, 25, "none"), "normal", truth).revenue - 1095.0) < 1e-9
    best = grid_best("normal", truth)
    assert abs(best - 1095.0) < 1e-6
    exp_regret = (1095.0 - 1000.0) / 1095.0
    assert abs(regret_of(decision(0, 21, "none"), "normal", truth, best=best)
               - exp_regret) < 1e-9
    assert regret_of(decision(0, 25, "none"), "normal", truth, best=best) == 0.0


def test_promo_saturates():
    truth = hand_truth_1seg(promo_amp=0.3)
    v_student = simulate(decision(0, 21, "student_deal"), "normal", truth)
    v_game = simulate(decision(0, 21, "game_day_special"), "normal", truth)
    # expected saturating shape: effect = amp * s/(s+0.7); strength 0.7 vs 1.0
    assert abs(v_student.visits_by_segment["students"] - 115.0) < 1e-3
    assert abs(v_game.visits_by_segment["students"] - 117.6470588) < 1e-3
    first_step = (v_student.visits_by_segment["students"] - 100.0)
    second_step = (v_game.visits_by_segment["students"] - v_student.visits_by_segment["students"])
    assert second_step < first_step    # diminishing returns from bigger promo


def test_naive_late_night_choice_actively_wrong():
    """'Open till 2 AM + game-day promo everywhere' must NOT be the optimum on
    at least one sampled truth seed: the late-night cliff + labor cost beat it."""
    naive_hits = 0
    for seed in range(12):
        truth = sample_truth(_fallback_ranges(["students", "regulars", "families"]), seed)
        naive = decision(0, 26, "game_day_special")
        r = regret_of(naive, "game_day", truth)
        if r > 0.005:
            naive_hits += 1
    assert naive_hits >= 4, f"naive late-night choice too good: hit in {naive_hits}/12 seeds"


def test_heldout_contexts_shift():
    truth = hand_truth_1seg(promo_amp=0.0)
    truth["segments_params"]["students"]["ctx"]["game_day"] = 0.4
    base = simulate(decision(0, 21, "none"), "normal", truth).revenue
    playoff = simulate(decision(0, 21, "none"), "playoff_weekend", truth).revenue
    comp = simulate(decision(0, 21, "none"), "new_competitor", truth).revenue
    assert playoff > base                 # amplified game-day signal
    assert comp < base                    # competitor drains traffic
    # unknown context degrades to normal
    assert simulate(decision(0, 21, "none"), "weird", truth) == \
        simulate(decision(0, 21, "none"), "normal", truth)


# ------------------------------------------------------------ truth sampling

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


def test_truth_ranges_cache_and_reroll(tmp_path=None):
    ranges = _fallback_ranges(["students", "regulars"])
    t1 = sample_truth(ranges, seed=42)
    assert set(t1["segments"]) == {"students", "regulars"}
    assert t1["global"]["avg_ticket"] != 0
    t_same = sample_truth(ranges, seed=42)
    assert t1["segments_params"] == t_same["segments_params"]
    t_diff = sample_truth(ranges, seed=43)
    assert t1["segments_params"] != t_diff["segments_params"]  # reroll changes truth

    path = (tmp_path or Path("_truth_cache_check.json"))
    try:
        save_truth(t1, path)
        assert load_truth(path)["seed"] == 42
        assert load_truth(path / ".." / "definitely-missing.json") is None
    finally:
        path.unlink(missing_ok=True)
    assert load_truth(TRUTH_PATH.parent / "_no_such_truth.json") is None


# ------------------------------------------------------- calibration fallback

def test_calibrate_degrades_without_key():
    async def main():
        return await calibrate_ranges(
            [{"stars": 2, "segment_hint": "regular", "text": "prices went up"},
             {"stars": 5, "segment_hint": "student", "text": "open late!"}],
            ["students", "regulars"], "local_consumer")
    ranges = asyncio.run(main())
    assert ranges["source"] in ("fallback", "llm")
    assert set(ranges["segments"]) == {"students", "regulars"}
    for name in ("base_visits_wk_total", "price_elasticity", "promo_amplitude",
                 "late_hours_labor_cost", "avg_ticket"):
        spec = ranges["ranges"][name]
        assert spec["min"] <= spec["max"]
    t = sample_truth(ranges, seed=1)
    assert t["segments"] == ["students", "regulars"]


# ------------------------------------------------------------- loop w/ FAKE LLM

class _FakeLLM:
    """Stateful fake: proposals are bad until beliefs contain 'KEEP_B';
    reflections hand out alternating unique notes so kept-vs-rejected beliefs
    are observable in later proposals."""
    PROMOS = {"good": (0, 25, "game_day_special"), "bad1": (20, 26, "game_day_special"),
              "bad2": (10, 24, "student_deal")}

    def __init__(self, jobs_per_round: int = 1):
        self.prop_calls = 0
        self.refl_calls = 0
        self.prop_beliefs = []
        self.jobs_per_round = jobs_per_round

    async def generate_many(self, jobs, concurrency=None):
        out = []
        for job in jobs:
            prompt = job["messages"][-1]["content"]
            if "Rewrite the belief note" in prompt:
                note = ["KEEP_A", "KEEP_B", "KEEP_A", "KEEP_B"][self.refl_calls % 4]
                self.refl_calls += 1
                out.append(json.dumps({"note": note}))
            else:
                round_no = self.prop_calls // self.jobs_per_round
                if "KEEP_B" in prompt:
                    key = "good"
                elif round_no % 2 == 0:
                    key = "bad1"
                else:
                    key = "bad2"
                self.prop_beliefs.append("KEEP_B" in prompt)
                self.prop_calls += 1
                pct, hour, promo = self.PROMOS[key]
                out.append(json.dumps({
                    "price_change_pct": pct, "closing_hour": hour, "promo": promo,
                    "predicted_visits": {"students": 120.0}}))
        return out


def _two_personas():
    return [
        Persona(id="p1", segment="students", name="Sam the junior",
                profile="Undergrad regular.", source_review_ids=[], weight=2.0),
        Persona(id="p2", segment="students", name="Sam the senior",
                profile="Senior regular.", source_review_ids=[], weight=1.0),
    ]


def test_loop_keeps_only_improving_updates():
    fake = _FakeLLM(jobs_per_round=2)
    original = loop_mod.llm_client.generate_many
    loop_mod.llm_client.generate_many = fake.generate_many
    try:
        truth = hand_truth_1seg(promo_amp=0.3)
        rows = asyncio.run(loop_mod.run_loop(
            "local_consumer", _two_personas(), [], "How should we set price, "
            "hours, promos next week?", truth, rounds=5))
    finally:
        loop_mod.llm_client.generate_many = original

    assert len(rows) == 6 and all(r.split == "train" for r in rows)
    assert all(r.run_id == rows[0].run_id for r in rows)
    traj = [r.regret for r in rows]
    # bad -> less bad -> good (kept), then bad rounds rejected (no poison)
    assert traj[2] < traj[1] < traj[0]
    assert traj[3] > traj[2] and traj[4] > traj[2]
    # money shot: round-4+ proposals were built from round-2's KEPT beliefs
    # ("KEEP_A"), not from round-3's rejected reflection ("KEEP_B")
    assert fake.prop_calls == 12          # (rounds+1) * personas
    assert fake.refl_calls == 5           # reflections skipped on the final round
    # belief marker seen per proposal JOB (2 jobs/round): only round 2's pair
    # saw KEEP_B (the belief kept from round 1's reflection)
    assert fake.prop_beliefs == [False, False, False, False,
                                 True, True, False, False, False, False,
                                 False, False]
    final = loop_mod._RUN_STATE[rows[0].run_id]
    assert final["final_beliefs"]["students"] == "KEEP_A"
    assert "KEEP_B" not in json.dumps(final["final_beliefs"])


def test_loop_offline_without_keys():
    """Real lane client (empty here): generate_many returns [None, ...] ->
    heuristic proposals; loop still completes 6 scored rounds."""
    truth = sample_truth(_fallback_ranges(["students", "regulars"]), seed=5)
    rows = asyncio.run(loop_mod.run_loop(
        "local_consumer",
        [Persona(id="p1", segment="students", name="Sam", profile="x",
                 source_review_ids=[], weight=1.0)],
        [], "q", truth, rounds=5))
    assert len(rows) == 6
    assert all(0.0 <= r.regret <= 1.0 or r.regret is not None for r in rows)
    assert rows[-1].round == 5


# ------------------------------------------------------------------- eval

def test_final_eval_and_chart_data():
    from app.sim.eval import chart_data, final_eval

    fake = _FakeLLM()
    original = loop_mod.llm_client.generate_many
    loop_mod.llm_client.generate_many = fake.generate_many
    try:
        truth = hand_truth_1seg(promo_amp=0.3)
        rows = asyncio.run(loop_mod.run_loop(
            "local_consumer", _two_personas(), [], "q", truth, rounds=2))
    finally:
        loop_mod.llm_client.generate_many = original

    test_truths = [
        sample_truth(_fallback_ranges(["students"]), seed=101),
        sample_truth(_fallback_ranges(["students"]), seed=102),
    ]
    result = final_eval(rows, test_truths)
    assert set(result) >= {"baseline_regret", "final_regret", "test_regret"}
    assert result["baseline_regret"] == rows[0].regret
    assert result["final_regret"] == rows[-1].regret
    assert 0.0 <= result["test_regret"] <= 1.0

    chart = chart_data(rows, result)
    assert [p["round"] for p in chart["train_line"]] == [0, 1, 2]
    assert chart["final_test_bar"]["test_regret"] == result["test_regret"]
    assert chart_data(rows)["final_test_bar"] is None


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__, "-v"]))