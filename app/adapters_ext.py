"""Context adapters: evidence-only adapters (cards, no reviews) that enrich a
resolved entity (app.entity.resolve_entity) with weather / calendar / event /
company-web context. Same interface conventions as app.adapters: async,
per-adapter guarded (exceptions -> ([], []) + a status push, never raising),
status events pushed to the SSE bus. All four run in parallel via
run_context_adapters(entity, town, push).

Every HTTP path routes through app.entity's helpers (_tavily_search,
_http_get_json, geocode_city) so offline tests patch a single surface.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import date, datetime
from typing import Awaitable, Callable
from urllib.parse import quote_plus

from app import entity as _entity

log = logging.getLogger("adapters_ext")

Push = Callable[[dict], Awaitable[None]]

OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
WEATHER_SOURCE_URL = "https://open-meteo.com/"
NAGER_URL = "https://date.nager.at/api/v3/publicholidays/{year}/US"
NAGER_SOURCE_URL = "https://date.nager.at/"

W_RAIN_MM = 5.0     # card only above this precipitation
W_HOT_C = 30.0      # card only above this daily max
W_COLD_C = -5.0     # card only below this daily min


async def _noop(_ev: dict) -> None:
    return None


def _f(x):
    try:
        return float(x) if x is not None else None
    except (TypeError, ValueError):
        return None


def _at(lst, i):
    try:
        return lst[i]
    except Exception:  # noqa: BLE001
        return None


def _card(i: int, claim: str, source_url: str, source_label: str, ctype: str,
          quote: str | None = None) -> dict:
    return {
        "id": f"ctx{i + 1}",
        "claim": (claim or "")[:180],
        "source_url": source_url or "",
        "source_label": (source_label or "web")[:80],
        "type": ctype,
        "quote": (quote or "").strip()[:400] or None,
    }


# ---------------------------------------------------------------- summarize

async def _summarize(entity: dict, town: str | None) -> dict | None:
    """The ONE cheap crowd-lane LLM pass over Tavily snippets. Returns
    {display_name, one_line_description, location, event_titles: [{title,date}]}
    or None (every adapter degrades to heuristics). Skips the LLM entirely when
    there are no snippets, which is also what keeps offline tests network-free."""
    try:
        from app.llm import client as llm
        ent = entity or {}
        name = ent.get("display_name") or ent.get("name") or ""
        if not name:
            return None
        loc = ent.get("location") or town or ""
        query = " ".join(x for x in (name, loc, "about") if x).strip()
        data = await _entity._tavily_search(query, max_results=4)
        snippets = [(r.get("content") or "").strip()[:300]
                    for r in (data.get("results") or [])
                    if (r.get("content") or "").strip()]
        if not snippets:
            return None
        raw = await llm.generate(
            [{"role": "system", "content": "Reply ONLY with a valid JSON object."},
             {"role": "user", "content":
                 "Web snippets about a business follow. Return JSON: "
                 "{\"display_name\": str, \"one_line_description\": str, "
                 "\"location\": str|null, \"event_titles\": "
                 "[{\"title\": str, \"date\": str|null}]}."
                 " Only include event_titles events actually named in the snippets.\n- "
                 + "\n- ".join(snippets)}],
            json_mode=True, prefer="crowd", max_tokens=400)
        if not raw:
            return None
        obj = json.loads(raw)
        if not isinstance(obj, dict):
            return None
        titles = []
        for t in (obj.get("event_titles") or []):
            if isinstance(t, dict) and str(t.get("title") or "").strip():
                d = t.get("date")
                titles.append({"title": str(t["title"]).strip(),
                               "date": d if isinstance(d, str) and d.strip() else None})
        return {
            "display_name": str(obj.get("display_name") or "").strip()[:80] or None,
            "one_line_description": str(obj.get("one_line_description") or "").strip()[:300] or None,
            "location": str(obj.get("location") or "").strip()[:80] or None,
            "event_titles": titles[:10],
        }
    except Exception as e:  # noqa: BLE001
        log.warning("context summarize degraded: %s", e)
        return None


# ---------------------------------------------------------------- adapters

async def weather_context(entity: dict, town: str | None, push: Push, summary: dict | None = None):
    """Open-Meteo 7-day forecast at the entity's coordinates (coordinates come
    from resolve_entity, or Open-Meteo geocoding of the location string). One
    card per SIGNIFICANT day: >5mm precip, >30C high, or < -5C low - noise is
    filtered."""
    push = push or _noop
    ent = entity or {}
    try:
        lat, lon = ent.get("lat"), ent.get("lon")
        if lat is None or lon is None:
            loc = ent.get("location") or town
            geo = await _entity.geocode_city((loc or "").split(",")[0].strip()) if loc else None
            if geo and geo.get("lat") is not None and geo.get("lon") is not None:
                lat, lon = geo["lat"], geo["lon"]
        if lat is None or lon is None:
            await push({"type": "status", "status": "scouting", "stage": "weather",
                        "detail": "skipped (no location)"})
            return [], []
        data = await _entity._http_get_json(OPEN_METEO_FORECAST_URL, params={
            "latitude": lat, "longitude": lon, "timezone": "auto", "forecast_days": 7,
            "daily": "temperature_2m_max,temperature_2m_min,precipitation_sum"})
        daily = (data or {}).get("daily") or {}
        dates = daily.get("time") or []
        precip = daily.get("precipitation_sum") or []
        tmax_l = daily.get("temperature_2m_max") or []
        tmin_l = daily.get("temperature_2m_min") or []
        cards = []
        for i, day in enumerate(dates[:7]):
            p, tx, tn = _f(_at(precip, i)), _f(_at(tmax_l, i)), _f(_at(tmin_l, i))
            sig = []
            if p is not None and p > W_RAIN_MM:
                sig.append(f"{p:.1f} mm precipitation")
            if tx is not None and tx > W_HOT_C:
                sig.append(f"hot (high {tx:.0f}C)")
            if tn is not None and tn < W_COLD_C:
                sig.append(f"cold (low {tn:.0f}C)")
            if not sig:
                continue
            temp = f" (high {tx:.0f}C / low {tn:.0f}C)" if tx is not None and tn is not None else ""
            cards.append(_card(len(cards), f"Expected weather {day}: " + ", ".join(sig) + temp,
                               WEATHER_SOURCE_URL, "Open-Meteo forecast", "weather"))
        await push({"type": "status", "status": "scouting", "stage": "weather",
                    "detail": f"{len(cards)} significant weather day(s)" if cards else "no significant weather"})
        return cards, []
    except Exception as e:  # noqa: BLE001
        log.warning("weather_context failed: %s", e)
        await push({"type": "status", "status": "scouting", "stage": "weather",
                    "detail": f"skipped (weather unavailable: {e})"})
        return [], []


async def calendar_context(entity: dict, town: str | None, push: Push, summary: dict | None = None):
    """Next up-to-3 US public holidays (date.nager.at, free, no key)."""
    push = push or _noop
    try:
        today = date.today()
        try:
            data = await _entity._http_get_json(NAGER_URL.format(year=today.year))
        except Exception as e:  # noqa: BLE001
            await push({"type": "status", "status": "scouting", "stage": "calendar",
                        "detail": f"skipped (calendar unavailable: {e})"})
            return [], []
        upcoming = []
        for h in (data if isinstance(data, list) else []):
            d = _parse_us_date(h.get("date"))
            if d is None or d < today or d.year != today.year:
                continue
            upcoming.append((d, h))
        upcoming.sort(key=lambda x: x[0])
        cards = [
            _card(i, f"Next US public holidays: {h.get('localName') or h.get('name') or 'Public holiday'}"
                     f" on {d.isoformat()}",
                  NAGER_SOURCE_URL, "US public holidays (date.nager.at)", "calendar")
            for i, (d, h) in enumerate(upcoming[:3])
        ]
        await push({"type": "status", "status": "scouting", "stage": "calendar",
                    "detail": f"{len(cards)} upcoming holiday(s)"})
        return cards, []
    except Exception as e:  # noqa: BLE001
        log.warning("calendar_context failed: %s", e)
        await push({"type": "status", "status": "scouting", "stage": "calendar",
                    "detail": f"skipped (calendar unavailable: {e})"})
        return [], []


_EVENT_DATE_RE = re.compile(
    r"\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|"
    r"Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}"
    r"(?:st|nd|rd|th)?(?:,?\s*\d{4})?|\b\d{1,2}/\d{1,2}(?:/\d{2,4})?\b", re.I)


async def events_context(entity: dict, town: str | None, push: Push, summary: dict | None = None):
    """Tavily events query for the business location; distinct event cards
    (title + date when derivable - LLM titles from the summarize pass if it
    ran, regex fallback). Cap 5 cards."""
    push = push or _noop
    ent = entity or {}
    try:
        location = ent.get("location") or town
        if not location:
            await push({"type": "status", "status": "scouting", "stage": "events",
                        "detail": "skipped (no location)"})
            return [], []
        data = await _entity._tavily_search(
            f"events concerts festivals near {location} next 30 days", max_results=10)
        parsed, seen = [], set()
        for t in ((summary or {}).get("event_titles") or []):
            title = str(t.get("title") or "").strip()
            key = title.lower()
            if not title or key in seen:
                continue
            seen.add(key)
            parsed.append({"title": title[:100], "date": t.get("date"),
                           "url": None, "snippet": ""})
        for r in (data.get("results") or []):
            title = re.sub(r"\s+", " ", (r.get("title") or "")).strip()
            content = re.sub(r"\s+", " ", (r.get("content") or "")).strip()
            if not title:
                continue
            key = title.lower()[:60]
            if key in seen:
                continue
            seen.add(key)
            m = _EVENT_DATE_RE.search(content[:200]) or _EVENT_DATE_RE.search(title)
            parsed.append({"title": title[:100],
                           "date": re.sub(r"\s+", " ", m.group(0)) if m else None,
                           "url": r.get("url"), "snippet": content[:200]})
        cards = []
        for e in parsed[:5]:
            title = e["title"]
            claim = f"Local event: {title}" + (f" - {e['date']}" if e.get("date") else "")
            url = e.get("url") or f"https://www.google.com/search?q={quote_plus(title)}"
            cards.append(_card(len(cards), claim, url, title[:80], "event",
                               quote=e.get("snippet") or None))
        await push({"type": "status", "status": "scouting", "stage": "events",
                    "detail": f"{len(cards)} event card(s)"})
        return cards, []
    except Exception as e:  # noqa: BLE001
        log.warning("events_context failed: %s", e)
        await push({"type": "status", "status": "scouting", "stage": "events",
                    "detail": f"skipped (events unavailable: {e})"})
        return [], []


async def company_context(entity: dict, town: str | None, push: Push, summary: dict | None = None):
    """ONLY when the entity resolved as a company: Tavily over funding /
    product / docs / GitHub news -> 4-8 public_info cards with real
    source_urls. This is the personas' raw material for startup-name-only
    sessions (the Luminal-demo path)."""
    push = push or _noop
    ent = entity or {}
    try:
        if ent.get("business_kind") != "company":
            await push({"type": "status", "status": "scouting", "stage": "company_context",
                        "detail": "skipped (not a company)"})
            return [], []
        name = ent.get("display_name") or ent.get("name") or ""
        if not name:
            await push({"type": "status", "status": "scouting", "stage": "company_context",
                        "detail": "skipped (no name)"})
            return [], []
        cards, seen = [], set()
        tokens = _entity._brand_tokens(name)   # drop unrelated same-query noise
        desc = (summary or {}).get("one_line_description")
        if desc:
            cards.append(_card(0, desc, ent.get("website") or
                               f"https://www.google.com/search?q={quote_plus(name)}",
                               f"{name} summary (web snippets)", "public_info", quote=desc))
        for q in (f"{name} funding investors", f"{name} product features docs github"):
            data = await _entity._tavily_search(q, max_results=5)
            for r in (data.get("results") or []):
                content = re.sub(r"\s+", " ", (r.get("content") or "")).strip()
                url = (r.get("url") or "").strip()
                blob = ((r.get("title") or "") + " " + content).lower()
                # markdown-table dumps (ranking pages) are noise, not claims
                if not content or not url or content.count("|") >= 4:
                    continue
                # only keep results about THIS brand (generic docs pages drop out)
                if not any(t in blob for t in tokens):
                    continue
                if url in seen:
                    continue
                seen.add(url)
                cards.append(_card(len(cards), content.split(". ")[0][:180], url,
                                   (r.get("title") or url).strip()[:80],
                                   "public_info", quote=content[:400]))
                if len(cards) >= 8:
                    break
            if len(cards) >= 8:
                break
        await push({"type": "status", "status": "scouting", "stage": "company_context",
                    "detail": f"{len(cards)} public-info card(s)"})
        return cards, []
    except Exception as e:  # noqa: BLE001
        log.warning("company_context failed: %s", e)
        await push({"type": "status", "status": "scouting", "stage": "company_context",
                    "detail": f"skipped (company context unavailable: {e})"})
        return [], []


# ---------------------------------------------------------------- runner

CONTEXT_ADAPTERS = [("weather", weather_context), ("calendar", calendar_context),
                    ("events", events_context), ("company_context", company_context)]


async def run_context_adapters(entity: dict, town: str | None, push: Push) -> tuple[list[dict], list[dict]]:
    """Run all 4 context adapters in parallel, each individually guarded, after
    the single crowd-lane LLM summarize pass. Returns (cards, reviews=[]) with
    cards id-re-id'd and deduped like app.adapters.run_adapters."""
    summary = None
    try:
        summary = await _summarize(entity, town)
    except Exception as e:  # noqa: BLE001
        log.warning("summarize failed: %s", e)

    async def guarded(nm: str, fn):
        try:
            return await fn(entity or {}, town, push, summary)
        except Exception as e:  # noqa: BLE001
            log.exception("context adapter %s failed", nm)
            try:
                await (push or _noop)({"type": "status", "status": "scouting",
                                       "stage": nm, "detail": f"failed: {e}"})
            except Exception:  # noqa: BLE001
                pass
            return [], []

    outs = await asyncio.gather(*(guarded(nm, fn) for nm, fn in CONTEXT_ADAPTERS))
    merged: list[dict] = []
    for c, _rv in outs:
        merged.extend(c)
    out, seen = [], set()
    for c in merged:
        key = (c.get("source_url") or "", (c.get("claim") or "")[:120])
        if key in seen:
            continue
        seen.add(key)
        out.append({**c, "id": f"e{len(out) + 1}"})
    return out, []


def _parse_us_date(s):
    try:
        return datetime.strptime(str(s or "")[:10], "%Y-%m-%d").date()
    except Exception:  # noqa: BLE001
        return None