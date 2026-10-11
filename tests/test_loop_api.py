"""Offline test for app/loop_api.py. ZERO network: generate/generate_many are
monkeypatched on app.llm.client with canned JSON routing on prompt markers
(same pattern as tests/test_llm_core.py) and storage is a fake dict-backed
object monkeypatched over loop_api._storage, so app.main is never imported.
Run:  python -m pytest tests/test_loop_api.py -v   (from project root)
"""
from __future__ import annotations
import asyncio, json, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest

from app.llm import client as llm_client
import app.loop_api as loop_api
from app.models import Persona

QUESTION = "Should we stay open until 2 AM on football Saturdays?"

# calibrate_ranges prompt: one JSON blob proposing all parameter ranges
CALIB_JSON = {
    "knobs": ["late_night_affinity"],
    "params": {
        "base_visits_wk_total": {"min": 150.0, "max": 400.0, "why": "walk-in traffic"},
        "price_elasticity": {"min": 0.005, "max": 0.015, "why": "price sensitivity"},
        "promo_amplitude": {"min": 0.2, "max": 0.4, "why": "promo lift"},
        "late_hours_labor_cost": {"min": 40.0, "max": 90.0, "why": "late staff"},
        "avg_ticket": {"min": 12.0, "max": 22.0, "why": "mid-tier check"},
        "late_night_affinity": {"min": 0.15, "max": 0.4, "why": "late-night share"},
        "appointment_density": {"min": 0.05, "max": 0.2, "why": "walk-in venue"},
    },
}


class FakeLLM:
    """Routes every lane on prompt markers; unmatched prompts are a hard
    failure, which is what makes 'zero network' assertable."""

    def __init__(self):
        self.calls = 0

    def route(self, messages: list[dict]) -> str:
        self.calls += 1
        blob = "\n".join(str(m.get("content", "")) for m in messages)
        if "demand-model calibration assistant" in blob:
            return json.dumps(CALIB_JSON)
        if "business-simulation agent" in blob:  # persona proposal
            import re as _re
            segs = _re.findall(r'"([^"{}]+)": <number>', blob)
            assert segs, f"no segments in proposal prompt:\n{blob[:400]}"
            return json.dumps({"price_change_pct": 0, "closing_hour": 23,
                               "promo": "none",
                               "predicted_visits": {s: 60.0 for s in segs}})
        if "You maintain belief notes" in blob:  # reflection
            return json.dumps({"note": "students respond to promos; keep hours at 23."})
        raise AssertionError(f"unrouted fake llm call (network escaped?):\n{blob[:400]}")

    async def generate(self, messages, prefer=None, *, temperature=0.7,
                       max_tokens=700, json_mode=False):
        return self.route(messages)

    async def generate_many(self, jobs, prefer=None, concurrency=None):
        return [self.route(j["messages"]) for j in jobs]


class FakeStorage:
    """Same async get/put/update semantics as app.storage.Storage, dict-backed."""

    backend = "memory"

    def __init__(self):
        self.mem: dict[str, dict] = {}

    async def get(self, session_id: str) -> dict | None:
        return self.mem.get(session_id)

    async def put(self, session_id: str, doc: dict) -> None:
        self.mem[session_id] = {**doc}

    async def update(self, session_id: str, patch: dict) -> None:
        cur = self.mem.get(session_id)
        if cur is None:
            return
        cur.update(patch)
        self.mem[session_id] = cur


def make_session(sid: str = "s_loop") -> dict:
    personas = [
        Persona(id="p1", segment="students", name="Sam the junior",
                profile="PSU junior, after-game wings.", source_review_ids=["e1"],
                weight=0.5),
        Persona(id="p2", segment="students", name="Tasha the night owl",
                profile="Eats late, bar-hours appetite.", source_review_ids=["e1"],
                weight=0.5),
        Persona(id="p3", segment="regulars", name="Marv the ten-year regular",
                profile="Weekly diner, price-sensitive now.",
                source_review_ids=["e2"], weight=0.5),
    ]
    return {
        "session_id": sid,
        "business": {"name": "Cafe 210", "town": "State College",
                     "business_class": "local_consumer"},
        "evidence": [],
        "segments": [{"name": "students", "count": 2},
                     {"name": "regulars", "count": 1}],
        "personas": [p.model_dump() for p in personas],
        "reviews": [
            {"id": "r1", "text": "students flood in after games, wings worth it",
             "rating": 5, "author": "sam"},
            {"id": "r2", "text": "prices went up but I still come weekly",
             "rating": 3, "author": "marv"},
        ],
        "question": QUESTION,
        "verdict": None, "paid": False, "status": "verdict_ready",
    }


@pytest.fixture()
def fake_env(monkeypatch):
    f = FakeLLM()
    store = FakeStorage()
    monkeypatch.setattr(llm_client, "generate", f.generate)
    monkeypatch.setattr(llm_client, "generate_many", f.generate_many)
    monkeypatch.setattr(loop_api, "_storage", lambda: store)
    monkeypatch.delenv("LOOP_SEED", raising=False)  # deterministic default 1234
    return f, store


def test_loop_run_offline(fake_env):
    f, store = fake_env
    sid = "s_loop"
    store.mem[sid] = make_session(sid)

    summary = asyncio.run(loop_api.run_loop_for_session(sid))
    doc = store.mem[sid]

    # round_scores rows: round 0 baseline + rounds 1..5 -> 6 rows
    rows = summary["round_scores"]
    assert len(rows) == 6
    assert [r["round"] for r in rows] == list(range(6))
    for r in rows:
        assert {"run_id", "round", "regret", "prediction_error", "split"} <= set(r)
        assert r["split"] == "train"
        assert isinstance(r["regret"], float)

    # final_eval keys present
    fe = summary["final_eval"]
    for k in ("baseline_regret", "final_regret", "test_regret",
              "shifted_context_regret"):
        assert k in fe, fe

    # chart + persisted keys
    chart = summary["chart"]
    assert len(chart["train_line"]) == 6
    assert chart["final_test_bar"]["test_regret"] == fe["test_regret"]
    assert doc["loop"]["truth_seed"] == 1234  # LOOP_SEED default
    assert doc["loop"]["round_scores"] == rows
    # beliefs: final belief note per stored truth segment
    assert doc["beliefs"].keys() == set(summary["truth"]["segments"])
    assert all(isinstance(n, str) for n in doc["beliefs"].values())
    assert f.calls > 0  # the fake was actually exercised (all routed)


def test_reroll_changes_truth(fake_env):
    f, store = fake_env
    sid = "s_reroll"
    store.mem[sid] = make_session(sid)

    first = asyncio.run(loop_api.run_loop_for_session(sid))
    t1 = first["truth"]

    second = asyncio.run(loop_api.regenerate_truth(sid, 777))
    t2 = store.mem[sid]["loop"]["truth"]

    assert second["truth_seed"] == 777
    assert t2["seed"] == 777
    assert t1 != t2            # different seed -> different truth
    assert first["truth_ranges"] == second["truth_ranges"]  # ranges not recalibrated
    # the chart in storage now reflects the reroll
    assert store.mem[sid]["loop"]["chart"]["final_test_bar"]["final_regret"] \
        == second["final_eval"]["final_regret"]


def test_error_guards(fake_env):
    f, store = fake_env

    # missing session -> KeyError
    with pytest.raises(KeyError):
        asyncio.run(loop_api.run_loop_for_session("s_missing"))

    # personas empty -> ValueError('run debate first')
    doc = make_session("s_personas")
    doc["personas"] = []
    store.mem["s_personas"] = doc
    with pytest.raises(ValueError, match="run debate first"):
        asyncio.run(loop_api.run_loop_for_session("s_personas"))

    # reviews empty -> ValueError
    doc = make_session("s_reviews")
    doc["reviews"] = []
    store.mem["s_reviews"] = doc
    with pytest.raises(ValueError, match="no reviews"):
        asyncio.run(loop_api.run_loop_for_session("s_reviews"))

    # reroll without a prior loop -> ValueError
    store.mem["s_noloop"] = make_session("s_noloop")
    with pytest.raises(ValueError, match="run the loop first"):
        asyncio.run(loop_api.regenerate_truth("s_noloop", 7))

    # chart data: never-run session -> {}
    assert asyncio.run(loop_api.make_chart_data("s_noloop")) == {}
    with pytest.raises(KeyError):
        asyncio.run(loop_api.make_chart_data("s_missing"))


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))