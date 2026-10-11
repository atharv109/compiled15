"""FastAPI backend for the Customer Swarm hackathon. Owns everything under /api.
Live channel is one SSE stream per session; pipeline + debate run as background
tasks and push events into a per-session bus. Every stage degrades gracefully:
missing keys, missing modules and dead providers log and fall back, never 500."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import secrets
import time
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

import app.business_class as business_class
import app.mock_debate as mock_debate
from app.adapters import run_adapters
from app.models import BusinessClass
from app.storage import Storage

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("main")

PAY_LINK = os.getenv("PAY_LINK", "")  # optional alias for other real checkout links
STRIPE_LINK = os.getenv("STRIPE_LINK", "https://buy.stripe.com/test_placeholder")

PRICE = 19

# ---------------------------------------------------------------- bus + storage


class Bus:
    """Per-session SSE fanout: backlog replay + live subscriber queues."""

    def __init__(self) -> None:
        self.subs: dict[str, set[asyncio.Queue]] = {}
        self.backlog: dict[str, list[tuple[str, str]]] = {}

    def push(self, session_id: str, ev: dict) -> None:
        et = ev.get("type", "status")
        payload = json.dumps({k: v for k, v in ev.items() if k != "type"},
                             ensure_ascii=False, default=str)
        self.backlog.setdefault(session_id, []).append((et, payload))
        if len(self.backlog[session_id]) > 800:
            del self.backlog[session_id][:-800]
        for q in list(self.subs.get(session_id, ())):
            q.put_nowait((et, payload))

    def emitter(self, session_id: str):
        async def push(ev: dict) -> None:
            self.push(session_id, ev)
        return push

    def subscribe(self, session_id: str):
        q: asyncio.Queue = asyncio.Queue()
        backlog = list(self.backlog.get(session_id, []))
        self.subs.setdefault(session_id, set()).add(q)
        return backlog, q

    def unsubscribe(self, session_id: str, q: asyncio.Queue) -> None:
        self.subs.get(session_id, set()).discard(q)


bus = Bus()
storage = Storage()


def _plain(x):
    return json.loads(json.dumps(x, default=str))


# ---------------------------------------------------------------- debate registry
# Prefers the real pipeline (app.llm.personas -> app.llm.debate -> app.llm.judge);
# falls back to app.mock_debate (fixture replay) when those modules are missing
# or fail mid-run.


def _debate_module():
    try:
        from app.llm import debate as d  # noqa: PLC0415
        return d if hasattr(d, "run_debate") else None
    except Exception:  # noqa: BLE001
        return None


async def _live_debate(session_id: str, question: str, push) -> dict:
    """Orchestrates the other agents' modules; no debate logic lives here."""
    from app.llm import judge
    from app.llm import personas as personas_mod

    doc = await storage.get(session_id) or {}
    evidence = [_card_from(c) for c in doc.get("evidence") or []]
    reviews = doc.get("reviews") or []
    bc = business_class.classify((doc.get("business") or {}).get("business_class", ""))

    await push({"type": "status", "status": "debating", "round": 0})
    personas, segments = [], []
    out = await personas_mod.build_personas(bc, evidence, reviews)
    personas, segments = (list(out[0]), list(out[1])) if out else ([], [])
    if not personas:
        raise RuntimeError("personas module returned no personas")
    await storage.update(session_id, {
        "personas": _plain([p.model_dump() for p in personas]),
        "segments": [s if isinstance(s, dict) else s for s in segments],
    })
    for p in personas:
        await push({"type": "persona_start", "persona_id": p.id,
                    "segment": p.segment, "name": p.name})

    stances, camps = [], []
    async for ev in _debate_module().run_debate(session_id, question, bc, evidence, personas):
        await push(ev)
        t = ev.get("type")
        if t == "stance":
            stances.append(ev)
        elif t == "camp":
            camps.append(ev)

    verdict = await judge.judge(question, doc.get("business"), evidence, personas,
                                [_stance_from(s) for s in stances],
                                [_camp_from(c) for c in camps])
    v = verdict.model_dump()
    await push({"type": "verdict", **_plain(v)})
    return {"question": question, "verdict": _plain(v)}


def _card_from(c: dict):
    from app.models import EvidenceCard
    try:
        return EvidenceCard(**_plain(c))
    except Exception:  # noqa: BLE001
        return EvidenceCard(id=c.get("id", "e?"), claim=str(c.get("claim", "")),
                            source_url=str(c.get("source_url", "")),
                            source_label=str(c.get("source_label", "")),
                            type="public_info", quote=str(c.get("quote", "")))


def _stance_from(e: dict):
    from app.models import Stance
    return Stance(**e)


def _camp_from(e: dict):
    from app.models import Camp
    return Camp(round=e.get("round", 1), name=e.get("camp", ""), member_ids=e.get("member_ids", []),
                top_arguments=e.get("top_arguments", []))


async def _dispatch_debate(session_id: str, question: str) -> None:
    push = bus.emitter(session_id)
    try:
        if _debate_module() is None:
            result = await mock_debate.run_debate(session_id, question, push)
        else:
            try:
                result = await _live_debate(session_id, question, push)
            except Exception:  # noqa: BLE001
                log.exception("live debate failed; falling back to mock replay")
                await push({"type": "status", "status": "debating",
                            "detail": "live debate failed; replaying mock"})
                result = await mock_debate.run_debate(session_id, question, push)
    except Exception:  # noqa: BLE001
        log.exception("debate hook failed for %s", session_id)
        await push({"type": "status", "status": "debating",
                    "detail": "debate error (see server logs)"})
        result = {"question": question, "verdict": None}
    patch = {"question": result.get("question") or question,
             "status": "verdict_ready" if result.get("verdict") else "ready"}
    if result.get("verdict"):
        patch["verdict"] = result["verdict"]
    try:
        await storage.update(session_id, patch)
    except Exception:  # noqa: BLE001
        log.exception("snapshot update failed for %s", session_id)
    # mongo mirror: the semantic corpus (debates w/ verdict; personas refreshed)
    try:
        import app.mongo_mirror as mirror
        doc = await storage.get(session_id) or {}
        await mirror.mirror_verdict(session_id, patch["question"],
                                    patch.get("verdict"), [])
        await mirror.mirror_ingest(session_id, doc.get("business") or {},
                                   [], doc.get("personas") or [],
                                   doc.get("segments") or [],
                                   len(doc.get("reviews") or []))
    except Exception:  # noqa: BLE001
        pass


# ---------------------------------------------------------------- pipeline


async def _run_pipeline(session_id: str, business_name: str, town: str | None,
                        reviews_text: str | None, mock: bool,
                        anchor_url: str | None = None) -> None:
    push = bus.emitter(session_id)
    try:
        await push({"type": "status", "status": "ingesting"})
        if mock:
            snap = await mock_debate.replay_ingest(session_id, push)
            await storage.update(session_id, snap)
            return

        # ---- entity resolution (name-only intake support) ----
        entity = None
        log.info("resolve branch: anchor=%r town=%r", anchor_url, town)
        if anchor_url or not town:
            try:
                from app.entity import resolve_entity
                entity = await resolve_entity(business_name, anchor_url, town)
                log.info("resolve OK kind=%s loc=%s conf=%s",
                         entity.get("business_kind"), entity.get("location"),
                         entity.get("confidence"))
                await push({"type": "status", "status": "scouting",
                            "stage": "resolved", "entity": {
                                k: entity.get(k) for k in
                                ("display_name", "location", "business_kind",
                                 "confidence", "candidates") if entity.get(k)}})
                if entity.get("candidates"):
                    await push({"type": "status", "status": "scouting",
                                "stage": "candidates",
                                "candidates": entity["candidates"]})
                town = town or (entity.get("city") or "")
                if not anchor_url and entity.get("maps_url"):
                    anchor_url = entity["maps_url"]
            except Exception as e:  # noqa: BLE001
                log.warning("entity resolution failed: %s", e)
                entity = None

        bc = await business_class.detect(
            business_name, town or "",
            ((entity or {}).get("description") or "") + (reviews_text or ""))
        await storage.update(session_id, {
            "business": {"name": business_name, "town": town or "",
                         "business_class": bc.value,
                         "entity": {k: v for k, v in (entity or {}).items()
                                    if isinstance(v, str) or k == "candidates"}}})
        await push({"type": "status", "status": "scouting", "stage": "classified",
                    "business_class": bc.value})
        await push({"type": "status", "status": "scouting",
                    "detail": f"persona family: {_family(bc)}"})

        cards, reviews = await run_adapters(business_name, town, reviews_text,
                                            push, entity=entity,
                                            anchor_url=anchor_url)
        for card in cards:
            await push({"type": "evidence", "card": card})
        try:
            from app.adapters_ext import run_context_adapters
            ctx_cards, _ = await run_context_adapters(entity or {}, town or "", push)
        except ImportError:
            log.warning("context adapters module absent — context cards skipped")
            ctx_cards = []
        for card in ctx_cards:
            await push({"type": "evidence", "card": card})
        cards = cards + ctx_cards
        await storage.update(session_id, {"evidence": cards, "reviews": reviews,
                                          "status": "ready"})
        # mongo mirror: businesses + evidence
        try:
            import app.mongo_mirror as mirror
            await mirror.mirror_ingest(session_id, {"name": business_name,
                                                    "town": town or "",
                                                    "business_class": bc.value},
                                       cards, [], [], len(reviews))
        except Exception:  # noqa: BLE001
            pass
        await push({"type": "status", "status": "ready", "evidence_count": len(cards)})
    except Exception as e:  # noqa: BLE001
        log.exception("pipeline failed for %s", session_id)
        try:
            await storage.update(session_id, {"status": "ready"})
            await push({"type": "status", "status": "ready", "detail": f"pipeline degraded: {e}"})
        except Exception:  # noqa: BLE001
            log.exception("pipeline error handler also failed for %s", session_id)


def _family(bc: BusinessClass) -> str:
    from app.models import PERSONA_FAMILY_HINTS
    return PERSONA_FAMILY_HINTS.get(bc.value, "")[:120]


# ---------------------------------------------------------------- app + models


@asynccontextmanager
async def _lifespan(app: FastAPI):
    log.info("storage backend: %s", storage.backend)
    yield


app = FastAPI(title="Customer Swarm API", lifespan=_lifespan)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_STATIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static")
if os.path.isdir(_STATIC) and os.listdir(_STATIC):
    from fastapi.staticfiles import StaticFiles
    app.mount("/demo", StaticFiles(directory=_STATIC, html=True), name="demo")


class CreateReq(BaseModel):
    business_name: str
    town: str | None = None
    anchor_url: str | None = None      # user pasted Maps listing / website — authoritative
    reviews_text: str | None = None
    owner_email: str | None = None     # login-lite: who to re-find the session for
    mock: bool = False  # frontend dev mode: replay the recorded fixture


class QuestionReq(BaseModel):
    text: str


class _LoginReq(BaseModel):
    email: str


_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

QUESTION_MIN_CHARS = 12
QUESTION_MIN_WORDS = 4
_QUESTION_NUDGE = "Give the swarm a full question — specific, at least ~8 words"


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _session_summaries(docs: dict[str, dict], email: str) -> list[dict]:
    rows = []
    for doc in docs.values():
        if (doc.get("owner_email") or "").strip().lower() != email:
            continue
        b = doc.get("business") or {}
        rows.append({
            "session_id": doc.get("session_id"),
            "business_name": b.get("name"),
            "business_town": b.get("town"),
            "status": doc.get("status"),
            "question": doc.get("question"),
            "created": doc.get("created"),
        })
    rows.sort(key=lambda r: r.get("created") or "", reverse=True)
    return rows


def _snapshot(doc: dict) -> dict:
    if not doc:
        return {}
    b = dict(doc.get("business") or {})
    ent = b.get("entity") or {}
    out = {
        "session_id": doc.get("session_id"),
        "business": {"name": b.get("name"), "town": b.get("town"),
                     **({"business_class": b["business_class"]} if b.get("business_class") else {}),
                     **({"entity": {k: ent[k] for k in ent
                                    if k in ("display_name", "location", "lat", "lon",
                                             "business_kind", "confidence", "candidates",
                                             "maps_url", "website")}
                         } if ent else {})},
        "evidence": doc.get("evidence") or [],
        "personas": doc.get("personas") or [],
        "segments": doc.get("segments") or [],
        "question": doc.get("question"),
        "verdict": doc.get("verdict"),
        "paid": bool(doc.get("paid")),
        "status": doc.get("status", "ingesting"),
    }
    if doc.get("owner_email"):
        out["owner_email"] = doc["owner_email"]
    # payment gate: teaser (recommendation + confidence) until paid
    v = out["verdict"]
    if v and not out["paid"]:
        out["verdict"] = {k: v[k] for k in ("recommendation", "confidence") if k in v}
    return out


class _RerollBody(BaseModel):
    seed: int


@app.post("/api/sessions/{session_id}/run-loop")
async def run_loop_route(session_id: str):
    import app.loop_api as loop_api
    try:
        return await loop_api.run_loop_for_session(session_id)
    except KeyError as e:
        if "session not found" in str(e):
            raise HTTPException(status_code=404, detail=str(e)) from e
        raise
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e


@app.get("/api/sessions/{session_id}/loop-chart")
async def loop_chart_route(session_id: str):
    import app.loop_api as loop_api
    try:
        return await loop_api.make_chart_data(session_id)
    except KeyError as e:
        if "session not found" in str(e):
            raise HTTPException(status_code=404, detail=str(e)) from e
        raise
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e


@app.post("/api/sessions/{session_id}/loop/reroll")
async def reroll_route(session_id: str, body: _RerollBody):
    import app.loop_api as loop_api
    try:
        return await loop_api.regenerate_truth(session_id, body.seed)
    except KeyError as e:
        if "session not found" in str(e):
            raise HTTPException(status_code=404, detail=str(e)) from e
        raise
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e



async def _get_doc_or_404(session_id: str) -> dict:
    doc = await storage.get(session_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="session not found")
    return doc


@app.get("/")
async def root():
    return {"ok": True, "service": "customer-swarm", "storage": storage.backend}


@app.post("/api/sessions")
async def create_session(req: CreateReq):
    session_id = "s_" + secrets.token_hex(3)
    owner_email = (req.owner_email or "").strip().lower() or None
    doc = {
        "session_id": session_id,
        "business": {"name": req.business_name.strip(), "town": (req.town or "").strip()},
        "evidence": [], "personas": [], "segments": [],
        "question": None, "verdict": None, "paid": False,
        "status": "ingesting", "mock": req.mock,
        "reviews_text": req.reviews_text,
        "owner_email": owner_email, "created": _now_iso(),
    }
    await storage.put(session_id, doc)
    asyncio.get_running_loop().create_task(
        _run_pipeline(session_id, req.business_name, req.town, req.reviews_text,
                      req.mock, anchor_url=req.anchor_url))
    return {"session_id": session_id, "status": "ingesting"}


@app.get("/api/sessions/{session_id}")
async def get_session(session_id: str):
    return _snapshot(await _get_doc_or_404(session_id))


@app.post("/api/login")
async def login(req: _LoginReq):
    """Login-lite: no passwords (demo-grade auth — finds the sessions the
    identity created earlier so they can be re-opened after a restart).
    Returns {email, sessions:[...]} for every doc stamped with this email."""
    email = (req.email or "").strip().lower()
    if not _EMAIL_RE.match(email):
        raise HTTPException(status_code=422, detail="enter a valid email address")
    return {"email": email, "sessions": _session_summaries(await storage.all(), email)}


@app.get("/api/sessions/{session_id}/stream")
async def stream_session(session_id: str):
    await _get_doc_or_404(session_id)  # 404 fast; stream 500s are not allowed

    async def gen():
        backlog, q = bus.subscribe(session_id)
        try:
            for et, payload in backlog:
                yield {"event": et, "data": payload}
            while True:
                et, payload = await q.get()
                yield {"event": et, "data": payload}
        finally:
            bus.unsubscribe(session_id, q)

    return EventSourceResponse(gen())


@app.post("/api/sessions/{session_id}/question")
async def ask_question(session_id: str, req: QuestionReq):
    text = (req.text or "").strip()
    # mirrors the client question rule: garbage gets rejected before the
    # swarm is dispatched
    if len(text) < QUESTION_MIN_CHARS or len(text.split()) < QUESTION_MIN_WORDS:
        raise HTTPException(status_code=422, detail=_QUESTION_NUDGE)
    doc = await _get_doc_or_404(session_id)
    status = doc.get("status", "")
    if status in ("ingesting", "scouting"):
        raise HTTPException(status_code=409,
                            detail=f"session still {status}; wait for ready")
    asyncio.get_running_loop().create_task(_dispatch_debate(session_id, text))
    return {"ok": True}


@app.get("/api/sessions/{session_id}/pay")
async def get_pay(session_id: str):
    """Checkout handoff. The REAL payment link comes from env (STRIPE_LINK,
    or PAY_LINK alias); when no real link is configured the frontend must run
    the demo mark-paid flow — the backend returns a 409-shaped payload with a
    demo marker, never a fabricated external domain."""
    await _get_doc_or_404(session_id)
    provider = "stripe"
    link = STRIPE_LINK
    if not link or link.startswith("https://buy.stripe.com/test_placeholder"):
        if PAY_LINK:
            link = PAY_LINK
            provider = "external"
    if not link or ".local" in link or "/test_placeholder" in link:
        return {"payment_url": None, "price": PRICE, "provider": provider,
                "demo": True,
                "note": "no real payment link configured — unlock via mark-paid for the demo"}
    return {"payment_url": link, "price": PRICE, "provider": provider}


@app.post("/api/sessions/{session_id}/pay/mark-paid")
async def mark_paid(session_id: str):
    await _get_doc_or_404(session_id)
    await storage.update(session_id, {"paid": True})
    return {"ok": True, "paid": True}


class _ChatBody(BaseModel):
    message: str


FREE_CROSS_QUESTIONS = 3


@app.post("/api/sessions/{session_id}/agents/{persona_id}/chat")
async def agent_chat(session_id: str, persona_id: str, body: _ChatBody):
    from app.llm.chat import chat_with_agent
    doc = await _get_doc_or_404(session_id)
    used = int(doc.get("chat_free_used") or 0)
    if not doc.get("paid") and used >= FREE_CROSS_QUESTIONS:
        raise HTTPException(status_code=402,
                            detail="free cross-questions used — unlock for unlimited chat")
    persona = next((p for p in doc.get("personas") or [] if p.get("id") == persona_id), None)
    if persona is None:
        raise HTTPException(status_code=404, detail="persona not found")
    events = [{"type": t, **json.loads(p)} for t, p in bus.backlog.get(session_id, [])]
    result = await chat_with_agent(persona, (body.message or "").strip(),
                                   doc.get("evidence") or [], None,
                                   events, question=doc.get("question") or "")
    if not doc.get("paid"):
        await storage.update(session_id, {"chat_free_used": used + 1})
        result = {**result,
                  "free_remaining": FREE_CROSS_QUESTIONS - (used + 1),
                  "unlocked": False}
    else:
        result = {**result, "unlocked": True}
    return result


@app.get("/api/mock-session/{session_id}")
async def mock_session(session_id: str):
    snap = mock_debate.fixture_snapshot(session_id)
    if not snap:
        raise HTTPException(status_code=500, detail="fixture missing")
    return snap


if __name__ == "__main__":
    uvicorn.run("app.main:app", host="127.0.0.1", port=int(os.getenv("PORT", "8000")), reload=False)

# ---------------------------------------------------------------- act (P2)

class _ActBody(BaseModel):
    seed: int | None = None


@app.post("/api/sessions/{session_id}/act")
async def act_route(session_id: str):
    from app.llm.act import run_act
    doc = await _get_doc_or_404(session_id)
    if not doc.get("paid"):
        raise HTTPException(status_code=402, detail="payment required for Act")
    try:
        result = await run_act(
            doc.get("question") or "",
            doc.get("verdict"),
            bus.backlog.get(session_id, []),
            doc.get("evidence") or [],
            (doc.get("business") or {}).get("business_class", ""),
            on_event=bus.emitter(session_id),
        )
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    await storage.update(session_id, {"act": result})
    return result
