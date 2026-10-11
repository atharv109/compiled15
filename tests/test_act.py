"""Offline tests for the Act tab (P-act). ZERO network: client.generate /
generate_many are monkeypatched on app.llm.client with a canned fake that routes
draft and judge calls on prompt markers (FakeLLM pattern from test_llm_core.py).
Run:  python -m pytest tests/test_act.py -v   (from project root)
"""
from __future__ import annotations
import asyncio, json, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest

from app.llm import client as llm_client
from app.llm.act import (run_act, draft_artifacts, judge_artifacts,
                         artifact_type_for)

EVIDENCE = [
    {"id": "e1", "claim": "Students came after the game but waited forever; wings worth it.",
     "source_url": "", "source_label": "review", "type": "review"},
    {"id": "e2", "claim": "Families visit on move-in weekend, good portions, outdoor seating.",
     "source_url": "", "source_label": "review", "type": "review"},
    {"id": "e3", "claim": "Weekly regular complains: prices went up, cheese fries removed.",
     "source_url": "", "source_label": "review", "type": "review"},
    {"id": "e4", "claim": "Closes at 10 on a Friday while downtown is open til 2.",
     "source_url": "", "source_label": "review", "type": "review"},
]

VERDICT = {
    "recommendation": "Stay open until 2 AM on football Saturdays, keep early seating split.",
    "confidence": 0.71,
    "tally": {"support": 6, "oppose": 2, "neutral": 0},
    "objections": ["Late hours raise staff costs on top of rising prices."],
    "segment_impact": [
        {"segment": "students", "impact": "+50% visits on football Saturdays", "evidence_ids": ["e1"]},
        {"segment": "families", "impact": "unchanged if seating stays split", "evidence_ids": ["e2"]},
    ],
}

CAMP_SUPPORT_R2 = {"type": "camp", "round": 2, "camp": "Late-night loyalists",
                   "member_ids": ["p1", "p2"],
                   "top_arguments": ["Students flood in after games with nowhere else open",
                                     "Alumni tailgates end wanting wings at 1 AM"]}
CAMP_OPPOSE_R2 = {"type": "camp", "round": 2, "camp": "Open-late skeptics",
                  "member_ids": ["p4", "p5"],
                  "top_arguments": ["Late hours raise costs for a place already called pricey"]}
STANCE_EVENTS = [
    {"type": "stance", "round": 2, "persona_id": "p1", "segment": "students",
     "stance": "support", "stance_label": "Yes", "reason":
         "We pour in after games and nowhere good is serving.", "evidence_ids": ["e1"]},
    {"type": "stance", "round": 2, "persona_id": "p4", "segment": "regulars",
     "stance": "oppose", "stance_label": "No", "reason":
         "Prices are already up; late hours mean more staff cost.", "evidence_ids": ["e3"]},
]
DEBATE_EVENTS = [*STANCE_EVENTS, CAMP_SUPPORT_R2, CAMP_OPPOSE_R2]  # support wins 1-1... see tally below

JUDGE_REPLY = {"scores": [{"id": "d1", "score": 0.9, "why": "grounded in e1"},
                          {"id": "d2", "score": 0.6, "why": "fine but thinner"},
                          {"id": "d3", "score": 0.75, "why": "solid flyer copy"}],
               "best_id": "d1"}


class FakeActLLM:
    """Routes on prompt markers; drafts derive their title from the seed line so
    distictness is testable. Records each call (lane prefer, tokens, prompt)."""

    DRAFT_MARKER = "DRAFT ARTIFACT"
    JUDGE_MARKER = "SCORE EACH DRAFT"

    def __init__(self):
        self.calls: list[dict] = []
        self.draft_reply: str | None = None       # None -> default per-seed reply
        self.judge_reply: object = JUDGE_REPLY    # str/None -> served to the judge

    def route(self, messages: list[dict]) -> str:
        blob = "\n".join(str(m.get("content", "")) for m in messages)
        if self.JUDGE_MARKER in blob:
            if isinstance(self.judge_reply, (dict, list)):
                return json.dumps(self.judge_reply)
            return str(self.judge_reply)
        if self.DRAFT_MARKER in blob:
            if self.draft_reply is not None:
                return self.draft_reply
            import re as _re
            m = _re.search(r"SEED FOCUS:.*\n(.+)", blob)
            seed = (m.group(1) if m else "no seed").strip()
            return json.dumps({
                "title": f"Option for {seed[:28]}",
                "body_text": f"Artifact built around: {seed}",
                "rationale": "leans on e1 and e2",
                "evidence_ids": ["e1", "e2", "e99"]})  # e99 fabricated -> dropped
        raise AssertionError(f"unrouted fake call:\n{blob[:300]}")

    async def generate(self, messages, prefer=None, *, temperature=0.7,
                       max_tokens=700, json_mode=False):
        blob = "\n".join(str(m.get("content", "")) for m in messages)
        kind = ("judge" if self.JUDGE_MARKER in blob
                else "draft" if self.DRAFT_MARKER in blob else "?")
        self.calls.append({"kind": kind, "prefer": prefer, "temperature": temperature,
                           "max_tokens": max_tokens, "json_mode": json_mode, "blob": blob})
        if kind == "judge" and self.judge_reply is None:
            return None  # strong lane down -> fallback path
        return self.route(messages)

    async def generate_many(self, jobs, prefer=None, concurrency=None):
        return [await self.generate(j["messages"], prefer=prefer,
                                    temperature=j.get("temperature", 0.7),
                                    max_tokens=j.get("max_tokens", 700),
                                    json_mode=j.get("json_mode", False))
                for j in jobs]


@pytest.fixture()
def fake_llm(monkeypatch):
    f = FakeActLLM()
    monkeypatch.setattr(llm_client, "generate", f.generate)
    monkeypatch.setattr(llm_client, "generate_many", f.generate_many)
    return f


# ------------------------------------------------ artifact_type mapping


def test_artifact_type_mapping():
    assert artifact_type_for("local_consumer", "Should we stay open until 2 AM?") == "promo_copy"
    assert artifact_type_for("local_consumer", "Should we add a vegetarian menu item?") == "menu_item_copy"
    assert artifact_type_for("local_consumer", "Should we print a flyer for grand opening?") == "signage_flyer"
    assert artifact_type_for("local_consumer", "Raise prices 10%?") == "menu_item_copy"
    assert artifact_type_for("startup", "Should we chase investors?") == "landing_page_snippet"
    assert artifact_type_for("b2b_service", "Should we change billing hours?") == "schedule_policy"
    assert artifact_type_for("regulated", "Extend clinic hours?") == "schedule_policy"
    assert artifact_type_for("", "Anything") == "schedule_policy"


# ------------------------------------------------ drafts


def test_three_distinct_drafts_from_distinct_seeds(fake_llm):
    result = asyncio.run(draft_artifacts("Stay open until 2 AM on football Saturdays?",
                                         VERDICT, DEBATE_EVENTS, EVIDENCE,
                                         "local_consumer", n=3))
    assert len(result) == 3
    assert [d["id"] for d in result] == ["d1", "d2", "d3"]
    titles = [d["title"] for d in result]
    assert len(set(titles)) == 3, titles           # genuinely different seeds
    for d in result:
        assert set(d.keys()) == {"id", "title", "body_text", "rationale", "evidence_ids"}
        assert d["body_text"] and d["rationale"]
    fake_draft_calls = [c for c in fake_llm.calls if c["kind"] == "draft"]
    assert len(fake_draft_calls) == 3
    blobs = [c["blob"] for c in fake_draft_calls]
    assert any("Students flood in after games" in b for b in blobs)  # camp argument seed
    assert any("+50% visits" in b for b in blobs)                    # segment-impact seed
    assert len({b for b in blobs}) == 3                              # seeds all differ


def test_fabricated_evidence_ids_dropped(fake_llm):
    result = asyncio.run(draft_artifacts("Stay open until 2 AM?", VERDICT,
                                         DEBATE_EVENTS, EVIDENCE,
                                         "local_consumer", n=2))
    for d in result:
        assert d["evidence_ids"] == ["e1", "e2"]    # e99 dropped, real kept


def test_draft_lane_down_falls_back(fake_llm):
    fake_llm.draft_reply = "the lane timed out; no JSON here"
    result = asyncio.run(draft_artifacts("Stay open until 2 AM?", VERDICT,
                                         DEBATE_EVENTS, EVIDENCE,
                                         "local_consumer", n=2))
    assert len(result) == 2
    assert all(d["evidence_ids"] == [] for d in result)  # empty allowed
    assert all("drafting lane" in d["rationale"] for d in result)


def test_skeptic_camp_seeded_when_oppose_wins(fake_llm):
    oppose_verdict = dict(VERDICT, tally={"support": 2, "oppose": 6, "neutral": 0})
    asyncio.run(draft_artifacts("Stay open until 2 AM?", oppose_verdict,
                                DEBATE_EVENTS, EVIDENCE, "local_consumer", n=1))
    blob = [c for c in fake_llm.calls if c["kind"] == "draft"][0]["blob"]
    assert "Late hours raise costs for a place already called pricey" in blob  # skeptics' arg


def test_backlog_tuples_accepted(fake_llm):
    tuples = [(e["type"], json.dumps(e)) for e in DEBATE_EVENTS]
    result = asyncio.run(draft_artifacts("Stay open until 2 AM?", VERDICT, tuples,
                                         EVIDENCE, "local_consumer", n=1))
    blob = [c for c in fake_llm.calls if c["kind"] == "draft"][0]["blob"]
    assert "Students flood in after games with nowhere else open" in blob
    assert len(result) == 1


# ------------------------------------------------ judging


def test_judge_scores_and_best_pick(fake_llm):
    drafts = asyncio.run(draft_artifacts("Stay open until 2 AM?", VERDICT,
                                         DEBATE_EVENTS, EVIDENCE, "local_consumer"))
    out = asyncio.run(judge_artifacts("Stay open until 2 AM?", drafts, EVIDENCE,
                                      VERDICT, artifact_type="promo_copy"))
    assert set(out) >= {"drafts", "scores", "best_id", "artifact_type"}
    assert len(out["scores"]) == 3
    assert [s["id"] for s in out["scores"]] == ["d1", "d2", "d3"]
    assert all(0.0 <= s["score"] <= 1.0 for s in out["scores"])
    assert out["best_id"] == "d1"
    assert out["artifact_type"] == "promo_copy"
    assert out["fallback_used"] is False
    judge_call = [c for c in fake_llm.calls if c["kind"] == "judge"][0]
    assert judge_call["prefer"] == "strong" and judge_call["temperature"] == 0
    assert judge_call["max_tokens"] == 900


def test_judge_invalid_scores_dropped_and_clamped(fake_llm):
    fake_llm.judge_reply = {"scores": [
        {"id": "d1", "score": "great", "why": "non-numeric -> dropped"},
        {"id": "d9", "score": 0.8, "why": "unknown draft -> dropped"},
        {"id": "d3", "score": 1.4, "why": "clamped to 1.0"},
    ], "best_id": "d9"}
    drafts = [{"id": f"d{i+1}", "title": f"t{i}", "body_text": f"b{i}",
               "rationale": "leans on e1", "evidence_ids": ["e1"]} for i in range(3)]
    out = asyncio.run(judge_artifacts("q?", drafts, EVIDENCE, VERDICT))
    assert [s for s in out["scores"]] == [{"id": "d3", "score": 1.0,
                                           "why": "clamped to 1.0"}]
    assert out["best_id"] == "d3"                   # LLM best_id d9 is invalid


def test_judge_lane_down_deterministic_fallback(fake_llm):
    fake_llm.judge_reply = None
    drafts = [
        {"id": "d1", "title": "A", "body_text": "a", "rationale": "cites e1 and e2", "evidence_ids": ["e1"]},
        {"id": "d2", "title": "B", "body_text": "b", "rationale": "cites e1", "evidence_ids": ["e1"]},
        {"id": "d3", "title": "C", "body_text": "c", "rationale": "no citations", "evidence_ids": []},
    ]
    out = asyncio.run(judge_artifacts("q?", drafts, EVIDENCE, VERDICT))
    assert out["fallback_used"] is True
    by_id = {s["id"]: s for s in out["scores"]}
    assert by_id["d1"]["score"] == 1.0 > by_id["d2"]["score"] > by_id["d3"]["score"]
    assert out["best_id"] == "d1"                   # most evidence ids mentioned


def test_judge_unparsable_never_fails(fake_llm):
    fake_llm.judge_reply = "}{ total garbage"
    drafts = [{"id": "d1", "title": "A", "body_text": "a", "rationale": "e1", "evidence_ids": []}]
    out = asyncio.run(judge_artifacts("q?", drafts, EVIDENCE, VERDICT))
    assert out["best_id"] == "d1" and out["fallback_used"] is True


# ------------------------------------------------ run_act entrypoint


def test_run_act_full_flow_and_events(fake_llm):
    events: list[dict] = []
    async def on_event(ev: dict) -> None:
        events.append(ev)

    out = asyncio.run(run_act("Stay open until 2 AM on football Saturdays?",
                              VERDICT, DEBATE_EVENTS, EVIDENCE,
                              "local_consumer", on_event=on_event))
    assert set(out) >= {"drafts", "scores", "best_id", "artifact_type"}
    assert len(out["drafts"]) == 3 and out["best_id"] == "d1"
    assert all("stage_detail" in e and e["type"] == "act" for e in events)
    assert events[-1]["best_id"] == "d1"
    draft_calls = [c for c in fake_llm.calls if c["kind"] == "draft"]
    judge_calls = [c for c in fake_llm.calls if c["kind"] == "judge"]
    assert len(draft_calls) == 3 and len(judge_calls) == 1
    assert all(c["prefer"] == "crowd" and c["max_tokens"] == 700 and c["json_mode"] for c in draft_calls)
    assert judge_calls[0]["prefer"] == "strong"


def test_run_act_no_verdict_raises(fake_llm):
    with pytest.raises(ValueError, match="run debate first"):
        asyncio.run(run_act("q?", None, DEBATE_EVENTS, EVIDENCE, "local_consumer"))
    with pytest.raises(ValueError, match="run debate first"):
        asyncio.run(run_act("q?", {}, DEBATE_EVENTS, EVIDENCE, "local_consumer"))


def test_run_act_takes_backlog_tuples(fake_llm):
    out = asyncio.run(run_act("Stay open until 2 AM?", VERDICT,
                              [(e["type"], json.dumps(e)) for e in DEBATE_EVENTS],
                              EVIDENCE, "local_consumer"))
    assert out["best_id"] == "d1"


def test_verdict_model_shapes_accepted():
    """draft/judge accept Verdict-pydantic-shaped dicts AND tally as model dump —
    run through the pure helpers so this stays offline without the fake."""
    from app.llm.act import _majority_stance, _seed_pool
    assert _majority_stance(VERDICT, DEBATE_EVENTS) == "support"
    assert _majority_stance({"tally": {"support": 2, "oppose": 5}}, []) == "oppose"
    even = _majority_stance({"tally": {"support": 3, "oppose": 3}}, STANCE_EVENTS)  # 1-1
    assert even in {"support", "oppose"}
    seeds = _seed_pool("support", CAMP_SUPPORT_R2, VERDICT, DEBATE_EVENTS, 4)
    assert len(seeds) >= 4 and len(set(seeds)) == len(seeds)


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))