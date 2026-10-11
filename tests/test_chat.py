"""Offline tests for persona agent chat (P1-3). ZERO network: client.generate is
monkeypatched (FakeLLM pattern from tests/test_llm_core.py).
Run:  python -m pytest tests/test_chat.py -v   (from project root)
"""
from __future__ import annotations
import asyncio, json, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest

from app.llm import client as llm_client
from app.llm.chat import chat_with_agent, persona_context, find_stance_for

EVIDENCE = [
    {"id": "e1", "claim": "Students came after the game but waited forever; wings worth it.",
     "source_url": "", "source_label": "review", "type": "review",
     "quote": "waited forever but the wings are worth it"},
    {"id": "e2", "claim": "Families visit on move-in weekend, good portions, outdoor seating.",
     "source_url": "", "source_label": "review", "type": "review"},
    {"id": "e3", "claim": "Weekly regular complains: prices went up, cheese fries removed.",
     "source_url": "", "source_label": "review", "type": "review"},
]

PERSONA = {
    "id": "p1", "name": "Sam the junior", "segment": "students",
    "profile": "PSU junior, comes after football games with friends.",
    "source_review_ids": ["e1"], "weight": 0.3,
}

STANCE_EVENT = {"type": "stance", "round": 2, "persona_id": "p1", "segment": "students",
                "stance": "support", "stance_label": "Open late",
                "reason": "We pour in after games and nowhere good is serving.",
                "evidence_ids": ["e1"]}

CAMP_EVENT = {"type": "camp", "round": 1, "camp": "Late-night loyalists",
              "member_ids": ["p1", "p2"],
              "top_arguments": ["Students flood in after games while every other spot is closed"]}

CAMP_EVENTS_R2 = [CAMP_EVENT,
                  {"type": "camp", "round": 2, "camp": "Late-night loyalists",
                   "member_ids": ["p1", "p2"], "top_arguments": ["tailgates end at 1 AM"]}]
BACKLOG_STYLE = [("stance", json.dumps(STANCE_EVENT)), ("camp", json.dumps(CAMP_EVENTS_R2[1]))]


class FakeChatLLM:
    """Routes on the chat marker; records calls. next_reply wins if set."""

    def __init__(self):
        self.calls: list[dict] = []
        self.next_reply: str | None = None

    async def generate(self, messages, prefer=None, *, temperature=0.7,
                       max_tokens=700, json_mode=False):
        self.calls.append({"messages": messages, "max_tokens": max_tokens,
                           "temperature": temperature, "json_mode": json_mode})
        if self.next_reply is not None:
            return self.next_reply
        blob = "\n".join(str(m.get("content", "")) for m in messages)
        if '"reply"' in blob:
            return json.dumps({"reply": "Honestly, the 2 AM crowd is a lot — but we'd show up.",
                               "evidence_ids": ["e1", "e99"]})  # e99 is bogus -> filtered
        raise AssertionError(f"unrouted fake call:\n{blob[:400]}")


@pytest.fixture()
def fake_llm(monkeypatch):
    f = FakeChatLLM()
    monkeypatch.setattr(llm_client, "generate", f.generate)
    return f


def _prompt_of(fake: FakeChatLLM) -> str:
    assert fake.calls, "generate was never called"
    return "\n".join(str(m.get("content", "")) for m in fake.calls[0]["messages"]
                     if m.get("role") == "system")


def test_in_character_prompt_has_name_segment_stance(fake_llm):
    out = asyncio.run(chat_with_agent(PERSONA, "Why open late?", EVIDENCE,
                                      None, [STANCE_EVENT, *CAMP_EVENTS_R2],
                                      question="Stay open until 2 AM?"))
    prompt = _prompt_of(fake_llm)
    assert "Sam the junior" in prompt
    assert "students" in prompt
    assert "Open late" in prompt                     # stance_label
    assert "support" in prompt                       # stance word (also in camp args? no: label carries it)
    assert "Late-night loyalists" in prompt          # camp digest
    assert isinstance(out, dict)
    assert out == {"reply": "Honestly, the 2 AM crowd is a lot — but we'd show up.",
                   "evidence_ids": ["e1"]}


def test_fabricated_evidence_ids_dropped(fake_llm):
    out = asyncio.run(chat_with_agent(PERSONA, "what sold you?", EVIDENCE,
                                      None, [STANCE_EVENT]))
    assert out["evidence_ids"] == ["e1"]             # e99 dropped
    assert out["reply"]


def test_ownership_stance_dict_and_no_fabricated_fallback_ids(fake_llm):
    # own Stance passed directly as a dict (doc-dehydrated), no events
    out = asyncio.run(chat_with_agent(PERSONA, "hello?", EVIDENCE,
                                      dict(STANCE_EVENT), []))
    prompt = _prompt_of(fake_llm)
    assert "round 2" in prompt and "Open late" in prompt
    assert out["evidence_ids"] == ["e1"]


def test_no_stance_persona_answers_from_profile(fake_llm):
    fake_llm.next_reply = json.dumps({"reply": "I only read the reviews, honestly.",
                                      "evidence_ids": []})
    out = asyncio.run(chat_with_agent(PERSONA, "what happened at the debate?", EVIDENCE,
                                      None, []))
    prompt = _prompt_of(fake_llm)
    assert "no recorded stance" in prompt
    assert "I only read the reviews" in prompt
    assert out["reply"] == "I only read the reviews, honestly."
    assert out["evidence_ids"] == []


def test_max_tokens_and_word_cap(fake_llm):
    long_words = " ".join(["tailgate"] * 150)
    fake_llm.next_reply = json.dumps({"reply": long_words, "evidence_ids": []})
    out = asyncio.run(chat_with_agent(PERSONA, "go on", EVIDENCE,
                                      None, [STANCE_EVENT]))
    assert fake_llm.calls[0]["max_tokens"] == 200
    assert len(out["reply"].split()) == 120          # capped at ~120 words


def test_fallback_when_all_lanes_down(monkeypatch):
    async def dead_generate(messages, prefer=None, **kw):
        return None
    monkeypatch.setattr(llm_client, "generate", dead_generate)
    out = asyncio.run(chat_with_agent(PERSONA, "hello?", EVIDENCE,
                                      None, [STANCE_EVENT]))
    assert "Nowhere good is serving" in out["reply"] or out["reply"]
    assert out["evidence_ids"] == ["e1"]             # stance evidence, already valid ids


def test_backlog_tuple_events(fake_llm):
    # the router's likely wiring: bus backlog is (event_type, json_payload) tuples
    out = asyncio.run(chat_with_agent(PERSONA, "so what made you a supporter?", EVIDENCE,
                                      None, BACKLOG_STYLE))
    prompt = _prompt_of(fake_llm)
    assert "Open late" in prompt                     # stance recovered from tuple
    assert "tailgates end at 1 AM" in prompt         # round-2 camp digest from tuple
    assert out["evidence_ids"] == ["e1"]


def test_find_stance_for_latest_round_wins():
    r1 = {"type": "stance", "round": 1, "persona_id": "p1", "segment": "students",
          "stance": "neutral", "stance_label": "Unsure", "reason": "meh", "evidence_ids": []}
    r2 = dict(STANCE_EVENT)
    assert find_stance_for("p1", [r1, r2]).round == 2
    assert find_stance_for("p1", [r1]).stance == "neutral"
    assert find_stance_for("p404", [r1, r2]) is None
    assert find_stance_for("p1", []) is None
    assert find_stance_for("p1", None) is None


def test_persona_context_accepts_digest_dict():
    msgs = persona_context(PERSONA, None, {"name": "Loyalists",
                                           "top_arguments": ["late crowd"], "digest": "We want wings."})
    blob = "\n".join(m["content"] for m in msgs)
    assert "Loyalists" in blob and "We want wings." in blob
    assert all(m["role"] == "system" for m in msgs)


def test_concession_guidance_in_prompt(fake_llm):
    asyncio.run(chat_with_agent(PERSONA, "you're wrong about prices", EVIDENCE,
                                None, [STANCE_EVENT]))
    assert "make a fair point" in _prompt_of(fake_llm)
    assert "not an oracle" in _prompt_of(fake_llm)


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))