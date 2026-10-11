"""Learning loop (Track 1A) — API layer between app/main.py routes and the
simulator. Additive per docs/api-contract.md: nothing here renames existing
session fields; it only adds the "loop" and "beliefs" keys to the doc.

Storage access goes through app.main.storage (the instance created there
next to the SSE bus) so the in-memory/Mongo fallbacks stay in sync with the
rest of the app. The import is deferred into _storage() because app.main
imports this module to mount routes (avoids a circular import).

Errors are deliberately plain (KeyError / ValueError) so the route handlers
in main.py catch them and map to 404/409 — nothing here should ever kill
uvicorn. LLM work goes exclusively through app.llm.client (already imported
by app.sim.truth / app.sim.loop), so a fake in tests that patches
app.llm.client.generate/generate_many exercises the full flow offline.
"""
from __future__ import annotations

import json
import os

from app.models import Persona


def _plain(x):
    """JSON-safe deep copy (same trick main.py uses before storage.update)."""
    return json.loads(json.dumps(x, default=str))


def _storage():
    from app import main as api_main  # deferred: main mounts routes from here
    return api_main.storage


def _default_seed() -> int:
    try:
        return int(os.getenv("LOOP_SEED", "1234"))
    except ValueError:
        return 1234


def _norm_review(r: dict) -> dict:
    """Reviews are stored as {id,text,rating,author} (app/adapters.py); the
    simulator reads stars/segment_hint/text. Map rating->stars non-destructively."""
    r = dict(r)
    if r.get("stars") is None and isinstance(r.get("rating"), (int, float)):
        r["stars"] = int(r["rating"])
    return r


async def _load(session_id: str) -> tuple[dict, list[Persona], list[dict]]:
    """Session doc -> (doc, personas, reviews) with the route-level guards."""
    doc = await _storage().get(session_id)
    if doc is None:
        raise KeyError("session not found")
    personas = [Persona(**_plain(p)) for p in (doc.get("personas") or [])]
    reviews = [r for r in (doc.get("reviews") or []) if (r.get("text") or "").strip()]
    if not personas:
        raise ValueError("run debate first")
    if not reviews:
        raise ValueError("no reviews for this session")
    return doc, personas, reviews


async def _run_loop(session_id: str, seed: int, ranges: dict | None = None) -> dict:
    """Calibrate (unless ranges passed), sample truth, run the loop, eval,
    persist and return the summary."""
    from app.sim import eval as sim_eval
    from app.sim import loop as sim_loop
    from app.sim import truth as sim_truth

    doc, personas, reviews = await _load(session_id)
    bc = (doc.get("business") or {}).get("business_class") or "local_consumer"
    question = doc.get("question") or ""
    reviews = [_norm_review(r) for r in reviews]

    if ranges is None:
        ranges = await sim_truth.calibrate_ranges(
            reviews, [p.segment for p in personas], bc)
    truth = sim_truth.sample_truth(ranges, seed)

    # demand contexts derived from detected evidence (events/weather/etc);
    # falls back to the classic hardcoded set when derivation is unavailable
    ctx = None
    try:
        from app.sim.contexts import derive_contexts
        ctx = await derive_contexts(doc.get("evidence") or [], reviews, bc, seed)
    except Exception as e:  # noqa: BLE001
        import logging
        logging.getLogger("loop_api").warning("derive_contexts failed: %s", e)

    rows = await sim_loop.run_loop(bc, personas, reviews, question, truth,
                                   rounds=5, contexts_override=ctx)

    # held-out eval: 2 test truths from the SAME ranges, fresh seeds; final_eval
    # adds the shifted contexts internally (derived when available).
    final = sim_eval.final_eval(
        rows, [sim_truth.sample_truth(ranges, seed + 1),
               sim_truth.sample_truth(ranges, seed + 2)],
        contexts_override=ctx)

    run_id = rows[0].run_id
    beliefs = dict(sim_loop._RUN_STATE.get(run_id, {}).get("final_beliefs") or {})

    summary = {
        "truth_ranges": _plain(ranges),
        "truth_seed": seed,
        "truth": _plain(truth),
        "contexts": _plain(ctx) if ctx else None,
        "round_scores": [_plain(r.model_dump()) for r in rows],
        "final_eval": _plain(final),
        "chart": _plain(sim_eval.chart_data(rows, final)),
    }
    await _storage().update(session_id, {
        "loop": _plain(summary),
        "beliefs": _plain(beliefs),
    })
    # mongo mirror: beliefs + round_scores (fire-and-forget, never blocks)
    try:
        import app.mongo_mirror as mirror
        await mirror.mirror_loop(session_id, beliefs, summary)
    except Exception:  # noqa: BLE001
        pass
    return _plain({**summary, "beliefs": _plain(beliefs)})


async def run_loop_for_session(session_id: str) -> dict:
    """Full loop for one session: calibrate -> sample -> loop -> eval -> persist."""
    return await _run_loop(session_id, _default_seed())


async def regenerate_truth(session_id: str, seed: int) -> dict:
    """Reroll button: re-sample truth with the given seed using the ranges
    calibrated on the previous run (no new calibration call), then loop + eval."""
    doc = await _storage().get(session_id)
    if doc is None:
        raise KeyError("session not found")
    ranges = (doc.get("loop") or {}).get("truth_ranges")
    if not ranges:
        raise ValueError("run the loop first")
    return await _run_loop(session_id, int(seed), ranges=ranges)


async def make_chart_data(session_id: str) -> dict:
    """Stored chart (+beliefs, truth_seed, contexts) or {} if never run."""
    doc = await _storage().get(session_id)
    if doc is None:
        raise KeyError("session not found")
    loop = doc.get("loop") or {}
    if not loop.get("chart"):
        return {}
    return {
        "chart": loop.get("chart"),
        "truth_seed": loop.get("truth_seed"),
        "contexts": loop.get("contexts"),
        "beliefs": doc.get("beliefs") or {},
    }