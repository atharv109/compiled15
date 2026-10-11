"""Adapter registry. Each adapter is async, takes (business_name, town,
reviews_text), returns (cards: list[EvidenceCard-ish dicts], reviews: list[dict]).
Every adapter is individually guarded: an exception logs + yields zero cards and
never kills the run. Status events are pushed to the SSE bus as they start/finish.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from typing import Awaitable, Callable

import httpx

from app.config import cfg
from app.models import EvidenceCard

log = logging.getLogger("adapters")

Push = Callable[[dict], Awaitable[None]]


# ---------------- adapters ----------------

async def tavily_web(business_name: str, town: str, reviews_text: str | None, push: Push):
    """Tavily search for reviews/menu/pricing/hours; cards typed by keyword heuristic."""
    key = cfg.TAVILY_API_KEY
    if not key:
        await push({"type": "status", "status": "scouting", "stage": "tavily_web", "detail": "skipped (no TAVILY_API_KEY)"})
        return [], []

    queries = [
        f"{business_name} {town} reviews menu pricing hours",
        f"{business_name} {town} competitors alternatives similar",
    ]
    cards: list[dict] = []
    for qi, query in enumerate(queries):
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                r = await client.post(
                    "https://api.tavily.com/search",
                    headers={"Authorization": f"Bearer {key}"},
                    json={"query": query, "max_results": 5},
                )
                r.raise_for_status()
                data = r.json()
        except Exception as e:  # noqa: BLE001
            log.warning("tavily query failed: %s", e)
            await push({"type": "status", "status": "scouting", "stage": "tavily_web", "detail": f"query {qi + 1} failed: {e}"})
            continue

        for res in data.get("results") or []:
            content = (res.get("content") or "").strip()
            if not content:
                continue
            url = res.get("url") or ""
            title = (res.get("title") or url or "web").strip()[:80]
            low = (content + " " + url).lower()
            if any(k in low for k in ("competitor", "alternatives", "similar", "best ", "vs ")):
                ctype = "competitor"
            elif any(k in low for k in ("price", "pricing", "$", "cost", "menu")):
                ctype = "price"
            elif "review" in low:
                ctype = "review"
            else:
                ctype = "public_info"
            cards.append(EvidenceCard(
                id=f"e{len(cards) + 1}",
                claim=content.split(". ")[0][:180],
                source_url=url,
                source_label=title,
                type=ctype,
                quote=content[:400],
            ).model_dump())
        cards = cards[:8]

    return cards, []


async def google_reviews(business_name: str, town: str, reviews_text: str | None, push: Push):
    """Reviews come from the scraper sidecar via app.scrape.bridge (another agent).
    If the bridge module is not present, emit an offline status and fall through."""
    try:
        from app.scrape import bridge  # noqa: F401  (optional, other agent owns this)
    except Exception:  # noqa: BLE001
        await push({"type": "status", "status": "scouting", "stage": "google_reviews",
                    "detail": "scraper sidecar offline"})
        return [], []
    reviews: list[dict] = []
    if (_entity_state or {}).get("business_kind") == "company":
        await push({"type": "status", "status": "scouting",
                    "stage": "google_reviews",
                    "detail": "skipped (company has no Google reviews)"})
        return [], []
    if hasattr(bridge, "fetch_reviews"):
        # Primary path: bridge emits its own status events (headless scrape,
        # human-in-the-loop captcha retry). Normalize bridge rows to review dicts.
        async def _bridge_push(ev: dict):
            await push({"type": "status", "status": "scouting",
                        "stage": "google_reviews", **ev})
        try:
            mu = (_entity_state.get("maps_url") or None)
            rows = await bridge.fetch_reviews(business_name, maps_url=mu,
                                              on_event=_bridge_push)
            for rv in rows:
                text = (rv.get("claim") or rv.get("text") or "").strip()
                if not text:
                    continue
                reviews.append({
                    "id": rv.get("id") or f"e_r{len(reviews) + 1}",
                    "text": text,
                    "rating": rv.get("rating"),
                    "author": rv.get("author"),
                })
        except Exception as e:  # noqa: BLE001
            log.warning("google_reviews bridge fetch failed: %s", e)
    else:
        for attr in ("get_reviews", "scrape_reviews"):
            fn = getattr(bridge, attr, None)
            if fn is None:
                continue
            try:
                out = fn(business_name, town)
                if asyncio.iscoroutine(out):
                    out = await out
                reviews = list(out or [])
                break
            except Exception as e:  # noqa: BLE001
                log.warning("google_reviews bridge '%s' failed: %s", attr, e)
    cards = [
        EvidenceCard(
            id=rv["id"],
            claim=(rv.get("text") or "").strip()[:180],
            source_url=rv.get("source_url") or rv.get("url") or "https://www.google.com/maps",
            source_label=rv.get("source_label") or rv.get("author") or "Google review",
            type="review",
            quote=(rv.get("text") or "")[:400],
        ).model_dump()
        for rv in reviews if (rv.get("text") or "").strip()
    ]
    return cards, reviews


async def manual_paste(business_name: str, town: str, reviews_text: str | None, push: Push):
    """Owner-pasted reviews become review evidence cards + review dicts."""
    if not reviews_text or not reviews_text.strip():
        return [], []
    chunks = [c.strip() for c in re.split(r"\n\s*\n|\n(?=\s*(?:\d+\s*[★*]|\d+\/5\b))", reviews_text) if c.strip()]
    if not chunks:
        chunks = [reviews_text.strip()]
    reviews, cards = [], []
    for i, chunk in enumerate(chunks[:200]):
        first = chunk.split("\n")[0].strip()
        reviews.append({"id": f"e_m{i + 1}", "text": chunk[:1500], "rating": None, "author": "owner-paste"})
        cards.append(EvidenceCard(
            id=f"e_m{i + 1}",
            claim=first[:180],
            source_url="manual",
            source_label="Owner-pasted review",
            type="review",
            quote=chunk[:400],
        ).model_dump())
    return cards, reviews


ADAPTERS = [("tavily_web", tavily_web), ("google_reviews", google_reviews), ("manual_paste", manual_paste)]


# module-level context for the registered adapters (they receive positional
# args only; entity/anchor ride through here) — set by run_adapters
_entity_state: dict = {}


async def run_adapters(business_name: str, town: str, reviews_text: str | None,
                       push: Push, *, entity: object | None = None,
                       anchor_url: str | None = None):
    """Run all adapters in order; collect + id-dedupe evidence cards, collect reviews.
    entity (resolve_entity dict) may supply maps_url/website; anchor_url (user-
    pasted listing) is authoritative and wins over anything derived."""
    _entity_state.clear()
    if isinstance(entity, dict):
        _entity_state.update(entity)

    if anchor_url:
        # user knows their listing better than any search: pin it
        maps_url = anchor_url if any(
            h in anchor_url for h in ("maps", "goo.gl")) else None
        if isinstance(entity, dict):
            entity["maps_url"] = maps_url
            if not maps_url:
                entity["website"] = anchor_url
    cards: list[dict] = []
    reviews: list[dict] = []
    t0 = time.time()
    for name, fn in ADAPTERS:
        try:
            n_before = len(cards)
            c, rv = await fn(business_name, town, reviews_text, push)
            cards.extend(c)
            reviews.extend(rv)
            await push({"type": "status", "status": "scouting", "stage": name,
                        "detail": "done", "cards": len(cards) - n_before,
                        "elapsed_s": round(time.time() - t0, 1)})
        except Exception as e:  # noqa: BLE001
            log.exception("adapter %s failed", name)
            await push({"type": "status", "status": "scouting", "stage": name,
                        "detail": f"failed: {e}"})

    # re-id + dedupe
    out: list[dict] = []
    seen: set[str] = set()
    for c in cards:
        key = c.get("source_url", "") + "|" + c.get("quote", "")[:120]
        if key in seen:
            continue
        seen.add(key)
        c = {**c, "id": f"e{len(out) + 1}"}
        out.append(c)
    return out, reviews