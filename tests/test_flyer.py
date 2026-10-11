"""Offline tests for the Act->flyer PDF route (P3). ZERO network:
render_flyer is pure (reportlab, invariant output); the route function
app.main.flyer_pdf runs against a stub storage (no Mongo/Dynamo/file use).
Run:  python -m pytest tests/test_flyer.py -v   (from project root)
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest

from app.flyer import render_flyer

from fastapi import HTTPException

DRAFTS = [
    {"id": "d1", "title": "Open Late on Game Saturdays",
     "body_text": "This Saturday we stay open until 2 AM. Wing baskets at the "
                  "Late-Night Special price, every home-game weekend.\n"
                  "Bring the crew — the wings are worth the wait.",
     "rationale": "leans on the students' segment; e1 and e2",
     "evidence_ids": ["e1", "e2"]},
    {"id": "d2", "title": "Late-Night Wings, Saturday Only",
     "body_text": "Shorter, thinner draft: doors open til 2 AM Saturdays.",
     "rationale": "leans on e2", "evidence_ids": ["e2"]},
    {"id": "d3", "title": "Third lane (fallback copy)",
     "body_text": "(drafting lane unavailable; start from: the verdict recommendation)",
     "rationale": "fallback", "evidence_ids": []},
]

SESSION = {
    "session_id": "s_flyer_test",
    "business": {"name": "Moe's Extraordinary Hot Wings", "town": "State College",
                 "business_class": "local_consumer"},
    "question": "Should we stay open until 2 AM on football Saturdays?",
    "status": "verdict_ready",
    "verdict": {
        "recommendation": "Stay open until 2 AM on the six home football Saturdays only.",
        "confidence": 0.71,
        "tally": {"support": 6, "oppose": 2, "neutral": 0},
        "objections": ["Late hours raise staff costs on top of rising prices.",
                       "One strong late Saturday does not prove the next five."],
        "segment_impact": [
            {"segment": "students", "impact": "+50% visits on football Saturdays",
             "evidence_ids": ["e1"]},
            {"segment": "families", "impact": "unchanged if seating stays split",
             "evidence_ids": ["e2"]},
        ],
    },
    "evidence": [
        {"id": "e1",
         "claim": "Students came after the game but waited forever; wings worth it.",
         "source_url": "", "source_label": "review", "type": "review"},
        {"id": "e2", "claim": "Families visit on move-in weekend, good portions.",
         "source_url": "", "source_label": "review", "type": "review"},
        {"id": "e9", "type": "hours",
         "claim": "Currently open 11 AM - 10 PM daily",
         "source_url": "", "source_label": "site"},
    ],
    "act": {"drafts": DRAFTS, "scores": [{"id": "d1", "score": 0.9, "why": "grounded"}],
            "best_id": "d1", "artifact_type": "signage_flyer", "fallback_used": False},
}


# ------------------------------------------------ render_flyer


def test_pdf_magic_and_nontrivial_size():
    pdf = render_flyer(SESSION, DRAFTS[0])
    assert pdf[:5] == b"%PDF-"
    assert len(pdf) > 10_000      # a designed one-pager with an embedded png logo
    assert b"/Type /Page" in pdf or b"Pages" in pdf


def test_deterministic_bytes():
    a = render_flyer(SESSION, DRAFTS[0])
    b = render_flyer(SESSION, DRAFTS[0])
    assert a == b                 # invariant=1: same input -> identical bytes


def test_empty_and_degraded_shapes_survive():
    pdf = render_flyer({}, {})    # no business, no verdict, no evidence
    assert pdf[:5] == b"%PDF-"
    stripped = {k: v for k, v in SESSION.items() if k not in ("verdict", "evidence")}
    assert render_flyer(stripped, DRAFTS[2])[:5] == b"%PDF-"


def test_hours_only_when_evidence_has_it():
    from app.flyer import _hours_line
    with_hours = _hours_line(SESSION["evidence"])
    assert "11 AM" in with_hours
    assert _hours_line(SESSION["evidence"][:-1]) == ""   # hours card removed -> skip


# ------------------------------------------------ route (stubbed storage)


class _StubStorage:
    def __init__(self, doc):
        self._doc = doc

    async def get(self, session_id):
        return self._doc


def _route():
    import app.main as main_mod
    return main_mod, main_mod.flyer_pdf


def test_route_serves_pdf_bytes(monkeypatch):
    main_mod, route = _route()
    monkeypatch.setattr(main_mod, "storage", _StubStorage(SESSION))
    resp = asyncio.run(route("s_flyer_test", None))
    assert resp.media_type == "application/pdf"
    assert 'inline; filename="callcrowd-flyer-moe-s-extraordinary-hot-wings.pdf"' \
        in resp.headers["content-disposition"]
    assert resp.body[:5] == b"%PDF-" and len(resp.body) > 10_000


def test_route_draft_param_and_fallback(monkeypatch):
    main_mod, route = _route()
    monkeypatch.setattr(main_mod, "storage", _StubStorage(SESSION))
    picked = asyncio.run(route("s_flyer_test", "d2"))
    assert b"thinner draft" in picked.body          # d2's own body copy
    # unknown draft id -> falls back to best_id (d1)
    picked2 = asyncio.run(route("s_flyer_test", "d99"))
    assert b"Wing baskets at the" in picked2.body   # d1's body copy


def test_route_409_no_act(monkeypatch):
    main_mod, route = _route()
    no_act = {k: v for k, v in SESSION.items() if k != "act"}
    monkeypatch.setattr(main_mod, "storage", _StubStorage(no_act))
    with pytest.raises(HTTPException) as ei:
        asyncio.run(route("s_flyer_test", None))
    assert ei.value.status_code == 409
    assert "Run Act first" in ei.value.detail


def test_route_404_unknown_session(monkeypatch):
    main_mod, route = _route()
    monkeypatch.setattr(main_mod, "storage", _StubStorage(None))
    with pytest.raises(HTTPException) as ei:
        asyncio.run(route("never_there", None))
    assert ei.value.status_code == 404


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))