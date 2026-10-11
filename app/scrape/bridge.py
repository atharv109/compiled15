"""Bridge to the google-reviews-scraper-pro sidecar.

Async fetch of Google Maps reviews via the sidecar's REST API
(default http://127.0.0.1:8300, SCRAPER_SIDECAR_URL). HTTP + local
SQLite file access only — imports no scraper code.
"""

from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import urllib.parse
from pathlib import Path

import httpx

SIDECAR_URL = os.environ.get("SCRAPER_SIDECAR_URL", "http://127.0.0.1:8300")
SIDECAR_DIR = Path(__file__).resolve().parents[2] / "services" / "google-reviews-scraper-pro"
DB_PATH = SIDECAR_DIR / "reviews.db"

JOB_TIMEOUT_S = 300.0
POLL_INTERVAL_S = 2.0


MIN_CACHED_TEXT_REVIEWS = 30
REVIEW_CAP = 150


async def fetch_reviews(business_name: str, maps_url: str | None = None,
                        on_event=None) -> list[dict]:
    """Reviews for a business, in demo order: cache-first, then scrape.

    1. If the sidecar already holds enough text reviews for this place, return
       them without scraping (first-call behavior in production is the live one;
       later calls replay the cache).
    2. Otherwise scrape headless (runs in background, nothing on screen).
    3. If that fails (CAPTCHA / block / hard failure), retry ONCE headed — the
       visible Chrome window is the human-in-the-loop solve. Callers pass
       on_event(ev) so the UI can show 'scrape blocked — human needed'.
    """
    url = maps_url or _search_url(business_name)

    cached = await _try_cached(business_name)
    if cached is not None:
        if on_event:
            await _safe_ev(on_event, {"stage_detail": "reviews from cache",
                                       "count": len(cached)})
        return cached

    if on_event:
        await _safe_ev(on_event, {"stage_detail": "scraping Google reviews (headless)"})
    try:
        job_id = await _trigger_job(url, headless=True)
        await _await_job(job_id)
    except RuntimeError:
        if on_event:
            await _safe_ev(on_event, {"stage_detail": "scrape blocked — human needed",
                                      "human_needed": True})
        job_id = await _trigger_job(url, headless=False)  # visible Chrome
        await _await_job(job_id)

    place = await _resolve_place(business_name, url)
    if place is None:
        raise RuntimeError(
            f"Sidecar scrape finished but no place matching '{business_name}' was found"
        )
    raw = await _read_reviews(place["place_id"], cap=REVIEW_CAP)
    reviews = [_to_evidence(r, place) for r in raw]
    return [r for r in reviews if r["claim"]]


async def _try_cached(business_name: str) -> list[dict] | None:
    """Existing DB rows for this place, without scraping. None if too few."""
    try:
        place = await _resolve_place(business_name, "")
    except Exception:  # noqa: BLE001 — sidecar down, cache miss
        return None
    if place is None:
        return None
    try:
        rows = _read_reviews_sqlite(place["place_id"])
    except (RuntimeError, sqlite3.Error):
        return None
    text_rows = [r for r in rows if _flatten_text(r.get("review_text"))]
    if len(text_rows) < MIN_CACHED_TEXT_REVIEWS:
        return None
    return [r for r in (_to_evidence(row, place) for row in rows) if r["claim"]]


async def _safe_ev(on_event, ev: dict):
    try:
        r = on_event(ev)
        if asyncio.iscoroutine(r):
            await r
    except Exception:  # noqa: BLE001 — events must never kill the scrape
        pass


async def _trigger_job(url: str, headless: bool = False) -> str:
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(
            f"{SIDECAR_URL}/scrape",
            json={"url": url, "headless": headless, "max_reviews": REVIEW_CAP},
        )
        r.raise_for_status()
        job_id = r.json().get("job_id")
    if not job_id:
        raise RuntimeError("Sidecar did not return a job_id")
    return job_id


async def _await_job(job_id: str) -> dict:
    async with httpx.AsyncClient(timeout=15) as c:
        waited = 0.0
        while waited < JOB_TIMEOUT_S:
            r = await c.get(f"{SIDECAR_URL}/jobs/{job_id}")
            r.raise_for_status()
            job = r.json()
            status = job.get("status")
            if status == "completed":
                return job
            if status in ("failed", "cancelled"):
                raise RuntimeError(
                    f"Sidecar scrape job {job_id} {status}: {job.get('error_message')}"
                )
            await asyncio.sleep(POLL_INTERVAL_S)
            waited += POLL_INTERVAL_S
    raise RuntimeError(f"Sidecar scrape job {job_id} timed out after {JOB_TIMEOUT_S:g}s")


async def _resolve_place(business_name: str, url: str) -> dict | None:
    """Resolve the place in the sidecar DB for THIS business. Name match is
    REQUIRED — falling back to 'last place' would leak another business's
    reviews into an unrelated session (a data-contamination bug, not a fallback)."""
    name = business_name.casefold()
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get(f"{SIDECAR_URL}/places")
        r.raise_for_status()
        places = [p for p in r.json() if not p["original_url"].startswith("about:")]
    for p in places:
        if name in (p.get("place_name") or "").casefold():
            return p
    for p in places:
        if url and (url == p.get("original_url") or url == p.get("resolved_url")):
            return p
    return None


async def _read_reviews(place_id: str, cap: int | None = None) -> list[dict]:
    """Reviews from the sidecar API, falling back to reviews.db on disk."""
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get(
                f"{SIDECAR_URL}/reviews/{place_id}",
                params={"limit": cap or 1000, "include_deleted": False},
            )
            r.raise_for_status()
            data = r.json()
            if data.get("total"):
                return list(data["reviews"])
    except (httpx.HTTPError, OSError):
        pass
    return _read_reviews_sqlite(place_id)


def _read_reviews_sqlite(place_id: str) -> list[dict]:
    if not DB_PATH.exists():
        raise RuntimeError(f"Sidecar API unreachable and {DB_PATH} does not exist")
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    try:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT review_id, author, rating, review_text, review_date, profile_url"
            " FROM reviews WHERE place_id = ? AND is_deleted = 0"
            " ORDER BY review_date DESC, created_date DESC",
            (place_id,),
        ).fetchall()
        return [
            {
                "review_id": row["review_id"],
                "author": row["author"],
                "rating": row["rating"],
                "review_text": row["review_text"],
                "review_date": row["review_date"],
                "profile_url": row["profile_url"],
            }
            for row in rows
        ]
    finally:
        conn.close()


def _flatten_text(value: object) -> str:
    """review_text arrives as a language-tagged dict ({'en': '...' }),
    a JSON string of one, or a plain string. Return the review text."""
    if isinstance(value, dict):
        value = next(iter(value.values()), "") if value else ""
    elif isinstance(value, str) and value.lstrip().startswith("{"):
        try:
            parsed = json.loads(value)
        except ValueError:
            parsed = None
        if isinstance(parsed, dict):
            value = next(iter(parsed.values()), "") if parsed else ""
    return (value or "").strip()


def _to_evidence(r: dict, place: dict) -> dict:
    text = _flatten_text(r.get("review_text"))
    source_url = place.get("resolved_url") or place.get("original_url") or ""
    return {
        "id": r.get("review_id") or "",
        "claim": text,
        "source_url": source_url,
        "source_label": "Google review",
        "type": "review",
        "quote": text[:300] if text else None,
        "rating": r.get("rating"),
        "author": r.get("author"),
    }


def _search_url(business_name: str) -> str:
    return "https://www.google.com/maps/search/" + urllib.parse.quote(business_name).replace(
        "%20", "+"
    )