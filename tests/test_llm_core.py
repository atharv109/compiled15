"""Offline pipeline test for the LLM core. ZERO network: generate/generate_many are
monkeypatched on app.llm.client with canned JSON routing on prompt markers.
Run:  python -m pytest tests/test_llm_core.py -v   (from project root)
"""
from __future__ import annotations
import asyncio, json, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest

from app.llm import client as llm_client
from app.llm.personas import build_personas
from app.llm.debate import run_debate, collect_debate, cluster_camps
from app.llm.judge import judge, verdict_cache_key, compute_confidence, _verdict_cache
from app.models import EvidenceCard, Persona, Stance

bc = "local_consumer"
QUESTION = "Should we stay open until 2 AM on football Saturdays?"

EVIDENCE = [
    EvidenceCard(id="e1", claim="Students came after the game but waited forever; wings worth it.", source_url="", source_label="review", type="review", quote="waited forever but the wings are worth it"),
    EvidenceCard(id="e2", claim="Families visit on move-in weekend, good portions, outdoor seating.", source_url="", source_label="review", type="review"),
    EvidenceCard(id="e3", claim="Weekly regular complains: prices went up, cheese fries removed.", source_url="", source_label="review", type="review"),
    EvidenceCard(id="e4", claim="Consistent for 10 years, wants more vegetarian options.", source_url="", source_label="review", type="review"),
    EvidenceCard(id="e5", claim="Group of 12 accommodated on Saturday night, great server.", source_url="", source_label="review", type="review"),
    EvidenceCard(id="e6", claim="Closes at 10 on a Friday while downtown is open til 2.", source_url="", source_label="review", type="review"),
    EvidenceCard(id="e7", claim="Best spot to end a tailgate; stays open late on home games already.", source_url="", source_label="review", type="review"),
]

PERSONA_JSON = {
    "personas": [
        {"idx": 0, "name": "Sam the junior", "segment": "students", "profile": "PSU junior, comes after football games with friends.", "source_review_ids": ["e1", "e6"]},
        {"idx": 1, "name": "Tasha the night owl", "segment": "students", "profile": "Senior who eats late; wants bars-hours options.", "source_review_ids": ["e6"]},
        {"idx": 2, "name": "Dan the gamer", "segment": "students", "profile": "Junior, budget-conscious, shows up late to night sessions.", "source_review_ids": ["e1"]},
        {"idx": 3, "name": "Marv the ten-year regular", "segment": "regulars", "profile": "Retired, weekly diner, price-sensitive now.", "source_review_ids": ["e3", "e4"]},
        {"idx": 4, "name": "Ellen the quiet luncher", "segment": "regulars", "profile": "Comes for afternoon coffee, dislikes crowds.", "source_review_ids": ["e4"]},
        {"idx": 5, "name": "Priya the soccer mom", "segment": "families", "profile": "Parent of a freshman; visits on family weekends.", "source_review_ids": ["e2", "e5"]},
        {"idx": 6, "name": "Grandpa Joe", "segment": "families", "profile": "Older family man, takes grandkids on Saturdays.", "source_review_ids": ["e2"]},
        {"idx": 7, "name": "Zeke the tailgater", "segment": "game-day alumni", "profile": "Alumni tailgating crew leader, loves late nights at home games.", "source_review_ids": ["e7"]},
    ]
}

# persona_id -> (round1 json, round2 json)
STANCE_R1 = {
    "p1": {"stance": "support", "stance_label": "Yes, open late", "reason": "We pour in after games and nowhere good is serving.", "evidence_ids": ["e1", "e6"]},
    "p2": {"stance": "support", "stance_label": "Yes", "reason": "Late eats are exactly my life.", "evidence_ids": ["e6", "e99"]},  # e99 is bogus -> must be filtered
    "p3": {"stance": "oppose", "stance_label": "No", "reason": "Crowds and a cover vibe ruin it for me.", "evidence_ids": []},  # no real evidence -> must fall back to neutral
    "p4": {"stance": "oppose", "stance_label": "No", "reason": "Prices are already up; late hours mean more staff cost.", "evidence_ids": ["e3"]},
    "p5": {"stance": "neutral", "stance_label": "No opinion", "reason": "I only do afternoons anyway.", "evidence_ids": []},
    "p6": {"stance": "support", "stance_label": "Fine by us", "reason": "Families eat early, extra hours don't hurt us if seating is split.", "evidence_ids": ["e5"]},
    "p7": {"stance": "neutral", "stance_label": "Whatever", "reason": "Grandkids' bedtime rules my schedule.", "evidence_ids": []},
    "p8": {"stance": "support", "stance_label": "Absolutely", "reason": "Tailgate ends and we want wings at 1 AM.", "evidence_ids": ["e7"]},
}
STANCE_R2 = dict(STANCE_R1)
STANCE_R2["p3"] = {"stance": "support", "stance_label": "Changed my mind", "reason": "If it's bar-side separated I can avoid the crowd.", "evidence_ids": ["e1"]}
STANCE_R2["p7"] = {"stance": "support", "stance_label": "Early seating ok", "reason": "Early family seating stays if students have their side.", "evidence_ids": ["e2"]}
STANCE_R2["p4"] = {"stance": "oppose", "stance_label": "Still no", "reason": "My weekly bill already hurts.", "evidence_ids": ["e3"]}
STANCE_R2["p5"] = {"stance": "oppose", "stance_label": "Opposed now", "reason": "Heard the digest; late hours just raise my bill too.", "evidence_ids": ["e4"]}

CAMP_REPLY_SKEPTIC = {"name": "Open-late skeptics", "top_arguments": ["Late hours raise costs for a place already called pricey", "Regulars avoid peak-night crowds"], "digest": "The skeptics worry that 2 AM hours add staff cost on top of already-rising prices, and that regulars will avoid the crowded late nights that result."}
CAMP_REPLY_SUPPORT = {"name": "Late-night loyalists", "top_arguments": ["Students flood in after games while every other spot is closed", "Alumni tailgates end wanting wings at 1 AM"], "digest": "Supporters point out students pour in after games with nowhere else open, and alumni tailgaters want wings at 1 AM; families are fine if seating stays split."}

VERDICT_JSON = {
    "recommendation": "Stay open until 2 AM on football Saturdays, but keep early family seating split from the student/bar side.",
    "objections": [
        "Late hours raise staff costs on top of already-rising prices (Marv, Ellen).",
        "Weeknight and non-game demand does not justify permanent hours.",
    ],
    "segment_impact": [
        {"segment": "students", "impact": "+50% visits on football Saturdays", "evidence_ids": ["e1", "e6"]},
        {"segment": "game-day alumni", "impact": "+40% visits; tailgate after-parties land here", "evidence_ids": ["e7"]},
    ],
}

QUESTIONS_JSON = {"questions": ["Should we stay open until 2 AM on football Saturdays?", "Should we raise prices 10%?", "Should we add student deals?", "Should we expand the vegetarian menu?"]}


class FakeLLM:
    def __init__(self):
        self.persona_calls = 0
        self.judge_calls = 0

    def route(self, messages: list[dict]) -> str:
        blob = "\n".join(str(m.get("content", "")) for m in messages)
        if "STRUCTURED TALLY" in blob:
            self.judge_calls += 1
            return json.dumps(VERDICT_JSON)
        if "Build 10 distinct customer personas" in blob:
            self.persona_calls += 1
            if self.persona_calls == 1:
                return json.dumps(PERSONA_JSON)
            return '{"personas": []}'
        if "Produce for this camp" in blob:
            reply = CAMP_REPLY_SKEPTIC if '"stance": "oppose"' in blob else CAMP_REPLY_SUPPORT
            return json.dumps(reply)
        import re as _re
        m = _re.search(r"persona_id:\s*(p\d+)", blob)
        if m:
            pid = m.group(1)
            data = STANCE_R2 if "ROUND 2" in blob else STANCE_R1
            return json.dumps(data[pid])
        if "decision questions" in blob:
            return json.dumps(QUESTIONS_JSON)
        raise AssertionError(f"unrouted fake call:\n{blob[:400]}")

    async def generate(self, messages, prefer=None, *, temperature=0.7, max_tokens=300, json_mode=False):
        return self.route(messages)

    async def generate_many(self, jobs, prefer=None, concurrency=None):
        return [self.route(j["messages"]) for j in jobs]


@pytest.fixture()
def fake_llm(monkeypatch):
    f = FakeLLM()
    monkeypatch.setattr(llm_client, "generate", f.generate)
    monkeypatch.setattr(llm_client, "generate_many", f.generate_many)
    _verdict_cache.clear()
    return f


def test_full_pipeline_offline(fake_llm):
    async def run():
        return await build_personas(bc, EVIDENCE, [])
    personas, segments = asyncio.run(run())

    assert len(personas) == 8
    assert [p.id for p in personas] == [f"p{i}" for i in range(1, 9)]
    ev_ids = {e.id for e in EVIDENCE}
    assert all(set(p.source_review_ids) <= ev_ids for p in personas)
    seg_w = {}
    for p in personas:
        seg_w[p.segment] = seg_w.get(p.segment, 0) + 1
    for p in personas:
        assert abs(p.weight - seg_w[p.segment] / 8) < 1e-6, (p.id, p.segment, p.weight)
    assert sum(s["count"] for s in segments) == 8
    assert isinstance(segments[0], dict) and {"name", "count"} <= set(segments[0])

    result = asyncio.run(collect_debate("s_test", QUESTION, bc, EVIDENCE, personas))
    events, stances, camps = result["events"], result["stances"], result["camps"]

    stances_ev = [e for e in events if e["type"] == "stance"]
    camp_ev = [e for e in events if e["type"] == "camp"]
    r1 = [e for e in stances_ev if e["round"] == 1]
    r2 = [e for e in stances_ev if e["round"] == 2]
    assert len(r1) == 8 and len(r2) == 8
    # event order: all round-1 stances precede the first camp event of round 1
    first_r1_camp = next((i for i, e in enumerate(events) if e["type"] == "camp" and e["round"] == 1), None)
    assert first_r1_camp is not None
    assert all(events.index(e) < first_r1_camp for e in r1)
    # camps emitted at end of both rounds
    assert {e["round"] for e in camp_ev} == {1, 2}
    for e in camp_ev:
        assert set(e["member_ids"]) <= {p.id for p in personas}
        assert isinstance(e["camp"], str) and e["camp"]
    # validation rules
    for s in stances:
        assert set(s.evidence_ids) <= ev_ids
        if s.stance == "neutral":
            assert s.evidence_ids == []
    p2_r1 = next(s for s in stances if s.round == 1 and s.persona_id == "p2")
    assert p2_r1.evidence_ids == ["e6"]  # bogus e99 filtered, real id kept
    p3_r1 = next(s for s in stances if s.round == 1 and s.persona_id == "p3")
    assert p3_r1.stance == "neutral"  # oppose with zero real evidence -> neutral
    p5_r2 = next(s for s in stances if s.round == 2 and s.persona_id == "p5")
    assert p5_r2.stance == "oppose" and p5_r2.persona_id

    # camps cluster on segment x stance
    r1_camps = [c for c in camps if c.round == 1]
    assert any(c.name == "Undecided" for c in r1_camps)
    undecided = next(c for c in r1_camps if c.name == "Undecided")
    assert set(undecided.member_ids) == {"p3", "p5", "p7"}  # p3: oppose with no real evidence -> neutral
    assert any(len(c.top_arguments) >= 2 for c in r1_camps)

    # judge
    final_stances = [s for s in stances if s.round == 2]
    verdict = asyncio.run(judge(QUESTION, {"name": "Cafe 210", "town": "State College"},
                                EVIDENCE, personas, stances, camps))
    expected_conf = compute_confidence(final_stances, [c for c in camps if c.round == 2])
    assert verdict.confidence == expected_conf
    final_tally = {"support": sum(1 for s in final_stances if s.stance == "support"),
                   "oppose": sum(1 for s in final_stances if s.stance == "oppose"),
                   "neutral": sum(1 for s in final_stances if s.stance == "neutral")}
    assert verdict.tally == final_tally == {"support": 6, "oppose": 2, "neutral": 0}
    assert all(set(si.evidence_ids) <= ev_ids for si in verdict.segment_impact)
    assert len(verdict.objections) >= 2
    assert verdict.recommendation.startswith("Stay open until 2 AM")
    assert fake_llm.judge_calls == 1

    # cache: second judge call with same (business, question) makes zero LLM calls
    key = verdict_cache_key({"name": "Cafe 210", "town": "State College"}, QUESTION)
    verdict2 = asyncio.run(judge(QUESTION, {"name": "Cafe 210", "town": "State College"},
                                 EVIDENCE, personas, stances, camps))
    assert verdict2 is verdict
    assert fake_llm.judge_calls == 1  # no new call
    # different question -> new call
    await_check = asyncio.run(judge(QUESTION + "?", "other", EVIDENCE, personas, stances, camps))
    assert fake_llm.judge_calls == 2
    await_check.tally == {"support": 6, "oppose": 2, "neutral": 0}


def test_clusters_names_skeptics(fake_llm):
    stances = [Stance(round=1, persona_id=f"p{i+1}", segment="students", stance=a, stance_label=a, reason="r", evidence_ids=[])
               for i, a in enumerate(["oppose", "oppose", "oppose", "support"])]
    camps = cluster_camps(stances, 1)
    names = [c.name for c in camps]
    assert any("skeptics" in n.lower() for n in names)


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))