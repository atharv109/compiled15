"""Mongo projection of the semantic corpus — the sponsor-visible knowledge layer.

Mirrors the PRD-named collections from each session doc:
  businesses · evidence · personas · debates · beliefs · round_scores

Fire-and-forget by contract: every function catches everything and returns
False on any failure — the product must never block, break, or slow down
because of the mirror. Engages only when MONGO_URI is present and alive;
otherwise all calls are cheap no-ops.
"""
import asyncio
import os
from datetime import datetime, timezone

_client = None
_ok: bool | None = None  # None = untried; False = dead/disabled; True = live


def _db():
    global _client, _ok
    if _ok is False:
        return None
    if _client is None:
        uri = os.getenv("MONGO_URI", "")
        if not uri:
            _ok = False
            return None
        try:
            import logging
            from pymongo import MongoClient
            c = MongoClient(uri, serverSelectionTimeoutMS=3000)
            c.admin.command("ping")
            _client = c
            _ok = True
            logging.getLogger("mongo_mirror").info(
                "mongo mirror engaged: %s", uri.split("//")[0] + "//<redacted>")
        except Exception:  # noqa: BLE001
            _ok = False
            return None
    return _client["customer_swarm"]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _try(awaitable_or_fn):
    """Run a sync mirror fn in a thread; swallow + log failures."""
    import logging
    log = logging.getLogger("mongo_mirror")
    try:
        r = awaitable_or_fn()
        if r:
            log.info("mirror ok %s", r)
    except Exception as e:  # noqa: BLE001
        log.warning("mirror skipped: %s", str(e)[:200])


# ---------------------------------------------------------------- projections

def _upsert_business(db, sid: str, b: dict) -> None:
    db["businesses"].update_one(
        {"_id": b.get("name", sid) + "|" + (b.get("town") or "")},
        {"$set": {"name": b.get("name"), "town": b.get("town"),
                  "business_class": b.get("business_class"),
                  "entity": b.get("entity") or {},
                  "sources": b.get("sources") or [],
                  "last_session": sid, "updated": _now()}},
        upsert=True)


def _upsert_evidence(db, sid: str, cards: list) -> None:
    if not cards:
        return
    from pymongo import UpdateOne
    ops = [UpdateOne(
        {"_id": f"{sid}:{c.get('id', i)}"},
        {"$set": {"business_id": c.get("source_url", sid), "session_id": sid,
                  "claim": c.get("claim", ""), "source_url": c.get("source_url", ""),
                  "source_label": c.get("source_label", ""), "type": c.get("type", ""),
                  "quote": c.get("quote"), "updated": _now()}},
        {"session_id": sid}) for i, c in enumerate(cards)]
    db["evidence"].bulk_write(ops, ordered=False)


def _upsert_personas(db, sid: str, personas: list, segments: list) -> None:
    if not personas:
        return
    from pymongo import UpdateOne
    ops = [UpdateOne(
        {"_id": f"{sid}:{p.get('id')}"},
        {"$set": {"business_id": sid, "segment": p.get("segment"),
                  "name": p.get("name"), "profile": p.get("profile"),
                  "source_review_ids": p.get("source_review_ids") or [],
                  "weight": p.get("weight", 1.0), "updated": _now()}},
        {"session_id": sid}) for p in personas]
    db["personas"].bulk_write(ops, ordered=False)
    if segments:
        db["personas"].update_one(
            {"_id": f"{sid}:_segments"},
            {"$set": {"segments": segments, "updated": _now()}}, upsert=True)


def _upsert_debate(db, sid: str, question, verdict, stances) -> None:
    if not verdict:
        return
    db["debates"].update_one(
        {"_id": f"{sid}:q"},
        {"$set": {"business_id": sid, "question": question,
                  "rounds": stances[:400],
                  "verdict": verdict, "updated": _now()}},
        upsert=True)


def _upsert_beliefs(db, sid: str, beliefs: dict) -> None:
    if not beliefs:
        return
    for seg, note in beliefs.items():
        db["beliefs"].update_one(
            {"_id": f"{sid}:{seg}"},
            {"$set": {"segment": seg, "notes": note, "version": _now(), "score": None}},
            upsert=True)


def _upsert_round_scores(db, sid: str, loopd: dict) -> None:
    rows = loopd.get("round_scores") or []
    if not rows:
        return
    from pymongo import UpdateOne
    ops = [UpdateOne({"_id": f"{sid}:{r.get('run_id', 'run')}:{r.get('round')}"}, {
        "$set": {"business_id": sid, "run_id": r.get("run_id"),
                 "round": r.get("round"), "regret": r.get("regret"),
                 "prediction_error": r.get("prediction_error"),
                 "split": r.get("split")}}) for r in rows]
    db["round_scores"].bulk_write(ops, ordered=False)


# ---------------------------------------------------------------- public API

async def mirror_ingest(session_id: str, business: dict, evidence: list,
                        personas: list, segments: list, reviews_n: int) -> bool:
    """After intake/debate: businesses + evidence + personas."""
    db = _db()
    if db is None:
        return False
    def job():
        _upsert_business(db, session_id, {**business, "sources": {"reviews": reviews_n}})
        _upsert_evidence(db, session_id, evidence)
        _upsert_personas(db, session_id, personas, segments)
    await asyncio.to_thread(_try, job)
    return True


async def mirror_verdict(session_id: str, question, verdict, stances) -> bool:
    db = _db()
    if db is None:
        return False
    await asyncio.to_thread(
        _try, lambda: _upsert_debate(db, session_id, question, verdict, stances))
    return True


async def mirror_loop(session_id: str, beliefs: dict, loopd: dict) -> bool:
    db = _db()
    if db is None:
        return False
    def job():
        _upsert_beliefs(db, session_id, beliefs)
        _upsert_round_scores(db, session_id, loopd)
    await asyncio.to_thread(_try, job)
    return True