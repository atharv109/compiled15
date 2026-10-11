"""Mock debate: replay of tests/fixture-session.json through the SSE bus in real
time. Used for partner/UI testing before the real debate pipeline is online.
Signature matches the debate hook contract: run_debate(session_id, question, push).
Returns {"question": ..., "verdict": {...}} so the caller can update the snapshot.
"""
from __future__ import annotations

import asyncio
import json
import logging
import pathlib

log = logging.getLogger("mock_debate")

FIXTURE_PATH = pathlib.Path(__file__).resolve().parent.parent / "tests" / "fixture-session.json"

_fallback_events = [
    {"event": "stance", "data": {"round": 1, "persona_id": "p1", "segment": "customers",
                                 "stance": "neutral", "stance_label": "Undecided",
                                 "reason": "offline fixture missing.", "evidence_ids": []}},
    {"event": "verdict", "data": {"recommendation": "Mock replay unavailable (fixture missing).",
                                  "confidence": 0.0, "tally": {"support": 0, "oppose": 0, "neutral": 0},
                                  "objections": [], "segment_impact": []}},
]


def load_fixture() -> dict:
    try:
        with open(FIXTURE_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        log.warning("fixture not loadable at %s", FIXTURE_PATH)
        return {"snapshot": {}, "stream_events": _fallback_events}


def _paced() -> float:
    """Small delay between events so the SSE stream feels live."""
    return 0.35


DEBATE_EVENT_TYPES = {"persona_start", "stance", "camp", "verdict"}


async def run_debate(session_id: str, question: str, push) -> dict:
    fx = load_fixture()
    await push({"type": "status", "status": "debating", "round": 1})
    verdict: dict | None = None
    for ev in fx.get("stream_events", []):
        et = ev.get("event")
        if et not in DEBATE_EVENT_TYPES:
            continue
        await asyncio.sleep(_paced())
        data = dict(ev.get("data") or {})
        await push({"type": et, **data})
        if et == "verdict":
            verdict = data
    return {"question": question, "verdict": verdict}


# ---- fixture helpers used by /api/mock-session and mock ingest ----

def fixture_snapshot(session_id: str | None = None) -> dict:
    snap = dict(load_fixture().get("snapshot") or {})
    if session_id:
        snap["session_id"] = session_id
    return snap


async def replay_ingest(session_id: str, push) -> dict:
    """Pretend-pipeline for mock sessions: pushes status + evidence events and
    returns the fixture snapshot (minus verdict debate tail)."""
    fx = load_fixture()
    snap = fixture_snapshot(session_id)
    await push({"type": "status", "status": "ingesting", "stage": "mock"})
    await asyncio.sleep(_paced())
    await push({"type": "status", "status": "scouting", "stage": "mock", "detail": "mock fixture replay"})
    for card in snap.get("evidence") or []:
        await asyncio.sleep(_paced())
        await push({"type": "evidence", "card": card})
    await asyncio.sleep(_paced())
    await push({"type": "status", "status": "ready"})
    snap = dict(snap)
    snap["status"] = "ready"
    snap["verdict"] = None
    snap["question"] = None
    snap["paid"] = False
    return snap