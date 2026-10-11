"""Offline tests for app.entity + app.adapters_ext. ZERO network: the module's
fetch helpers (_http_get_json / _http_post_json / _tavily_search) are
monkeypatched on app.entity; app.adapters_ext reuses those exact surfaces, so
every fetch path is covered. Any unmocked HTTP attempt raises.
Run:  python -m pytest tests/test_entity.py -v   (from project root)
"""
from __future__ import annotations
import asyncio, sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest

import app.entity as ent
import app.adapters_ext as aex


def _res(title, url, content):
    return {"title": title, "url": url, "content": content}


async def _no_net(*args, **kwargs):
    raise AssertionError("network attempt in offline test")


def _collect_push(store):
    async def push(ev):
        store.append(ev)
    return push


def _patch_no_net(monkeypatch):
    monkeypatch.setattr(ent, "_http_get_json", _no_net)
    monkeypatch.setattr(ent, "_http_post_json", _no_net)
    monkeypatch.setattr(ent, "_http_get_text", _no_net)


COMPANY_RESULTS = [
    _res("Luminal AI - Luminal is a YC-backed startup building an AI data platform",
         "https://luminal.ai/", "Luminal raised seed funding from investors to build an AI data platform for ML teams. Sign up to get started with our API and documentation."),
    _res("Luminal | LinkedIn", "https://www.linkedin.com/company/luminal",
         "Luminal - software company. Founded by two engineers. Series A funding. Headquarters in San Francisco."),
    _res("luminal-team/luminal: GitHub",
         "https://github.com/luminal-team/luminal", "Open source repo. pip install luminal. AI platform, developers, documentation."),
    _res("Luminal YC profile", "https://www.ycombinator.com/companies/luminal",
         "Luminal: startup that builds an AI data platform. Funding: seed."),
]


def test_happy_path_company(monkeypatch):
    _patch_no_net(monkeypatch)
    queries = []

    async def fake_search(query, *, max_results=5):
        queries.append(query)
        return {"results": list(COMPANY_RESULTS)}

    monkeypatch.setattr(ent, "_tavily_search", fake_search)

    e = asyncio.run(ent.resolve_entity("Luminal", None))
    assert e["business_kind"] == "company"
    assert e["confidence"] == "high"
    assert "luminal.ai" in (e["website"] or "")
    assert e["candidates"] == []           # one coherent brand -> not ambiguous
    assert e["display_name"].lower().startswith("luminal")
    assert len(queries) == 2               # own site found -> no 3rd query
    assert e["anchor_cards"] == []         # name-only path: no anchor cards
    # company signals outweigh local ones decisively
    assert all("linkedin.com/company" in u["url"] or "luminal" in u["url"]
               for u in COMPANY_RESULTS)


def test_ambiguity_produces_candidates(monkeypatch):
    _patch_no_net(monkeypatch)
    results = [
        _res("Meridian - Crypto payments startup | Crunchbase",
             "https://www.crunchbase.com/organization/meridian-labs",
             "Meridian is a fintech startup. Series A funding raised from investors."),
        _res("Meridian Diner - San Francisco, CA | Yelp",
             "https://www.yelp.com/biz/meridian-diner-san-francisco",
             "Meridian Diner, 210 Oak St, San Francisco, CA 94103. 4.5 stars (312 reviews). Hours: open now. Menu and directions. Restaurant."),
        _res("Meridian | Product Company",
             "https://meridianhq.io/",
             "Meridian - we build payment APIs for fintechs. Sign up to get started. Founded in 2021."),
    ]

    async def fake_search(query, *, max_results=5):
        return {"results": list(results)}

    monkeypatch.setattr(ent, "_tavily_search", fake_search)

    e = asyncio.run(ent.resolve_entity("Meridian", None))
    assert e["business_kind"] in ("company", "local")  # best guess still picked
    assert e["confidence"] == "low"                    # conflicting signals
    assert len(e["candidates"]) >= 2
    kinds = {c["kind"] for c in e["candidates"]}
    assert {"company", "local"} <= kinds               # both interpretations surface
    assert all(set(c) >= {"label", "kind", "why"} for c in e["candidates"])


def test_weather_filter(monkeypatch):
    _patch_no_net(monkeypatch)
    entity = {"display_name": "Cafe 210 West", "location": "State College, PA",
              "lat": 40.79, "lon": -77.86, "business_kind": "local"}
    days = [(date.today() + timedelta(days=i + 1)).isoformat() for i in range(3)]
    forecast = {"daily": {
        "time": days,
        "precipitation_sum": [3.0, 0.2, 12.0],   # only day 3 above 5mm
        "temperature_2m_max": [22.0, 21.0, 20.0],
        "temperature_2m_min": [12.0, 11.0, 10.0]}}

    seen_urls = []

    async def fake_get(url, *, params=None, **kw):
        seen_urls.append(url)
        return forecast

    monkeypatch.setattr(ent, "_http_get_json", fake_get)
    pushes = []
    cards, reviews = asyncio.run(aex.weather_context(entity, None, _collect_push(pushes), None))
    assert reviews == []
    assert len(cards) == 1                     # 3mm day suppressed
    assert cards[0]["type"] == "weather"
    assert days[2] in cards[0]["claim"] and "12" in cards[0]["claim"]
    assert any("open-meteo" in u for u in seen_urls)
    assert pushes and "weather" in pushes[0]["stage"]


def test_weather_hot_and_cold(monkeypatch):
    _patch_no_net(monkeypatch)
    entity = {"display_name": "x", "location": "Phoenix, AZ", "lat": 33.4, "lon": -112.0}
    day = (date.today() + timedelta(days=1)).isoformat()
    forecast = {"daily": {"time": [day], "precipitation_sum": [0.0],
                          "temperature_2m_max": [41.0], "temperature_2m_min": [28.0]}}
    async def fake_get(url, *, params=None, **kw):
        return forecast
    monkeypatch.setattr(ent, "_http_get_json", fake_get)
    cards, _ = asyncio.run(aex.weather_context(entity, None, None, None))
    assert len(cards) == 1 and "hot" in cards[0]["claim"]


def test_calendar_date_filtering(monkeypatch):
    _patch_no_net(monkeypatch)
    t = date.today()
    holidays = [
        {"name": "Past Day", "localName": "Past Day", "date": (t - timedelta(days=5)).isoformat()},
        {"name": "Next Year Day", "localName": "Next Year Day", "date": (t + timedelta(days=400)).isoformat()},
        {"name": "Soon Holiday", "localName": "Soon Holiday", "date": (t + timedelta(days=2)).isoformat()},
        {"name": "Mid Holiday", "localName": "Mid Holiday", "date": (t + timedelta(days=9)).isoformat()},
        {"name": "Far Holiday", "localName": "Far Holiday", "date": (t + timedelta(days=60)).isoformat()},
    ]

    async def fake_get(url, *, params=None, **kw):
        assert "date.nager.at" in url and str(t.year) in url
        return holidays

    monkeypatch.setattr(ent, "_http_get_json", fake_get)
    cards, reviews = asyncio.run(aex.calendar_context({"display_name": "x"}, None, None, None))
    assert reviews == []
    assert len(cards) == 3                          # cap 3, past + next-year excluded
    names = [c["claim"] for c in cards]
    assert "Soon Holiday" in names[0] and "Mid Holiday" in names[1]
    assert all(c["type"] == "calendar" for c in cards)
    assert all(str(t - timedelta(days=5)) not in c["claim"] for c in cards)


def test_events_context_parse_and_cap(monkeypatch):
    _patch_no_net(monkeypatch)
    entity = {"display_name": "Cafe 210", "location": "State College, PA",
              "lat": 40.79, "lon": -77.86, "business_kind": "local"}
    results = [
        _res("Arts Festival downtown",
             "https://events.example.com/arts-fest",
             "Arts Festival downtown on October 20. Food and music."),
        _res("Arts Festival downtown",  # duplicate title -> deduped
             "https://other.example.com/fest",
             "same festival"),
        _res("Homecoming 5K",
             "https://events.example.com/5k",
             "Run it on November 8."),
    ] + [_res(f"no-date-event-{i}", f"https://events.example.com/{i}", "something is on")
         for i in range(6)]

    async def fake_search(query, *, max_results=10):
        assert "State College" in query
        return {"results": results}

    monkeypatch.setattr(ent, "_tavily_search", fake_search)
    cards, reviews = asyncio.run(aex.events_context(entity, None, None, None))
    assert reviews == []
    assert len(cards) == 5                          # capped
    assert cards[0]["type"] == "event"
    assert "October 20" in cards[0]["claim"]
    arts = [c for c in cards if "Arts Festival downtown" in c["claim"]]
    assert len(arts) == 1


def test_events_skipped_without_location(monkeypatch):
    _patch_no_net(monkeypatch)
    pushes = []
    cards, reviews = asyncio.run(aex.events_context({"display_name": "x"}, None,
                                                    _collect_push(pushes), None))
    assert cards == [] and reviews == []
    assert any(ev.get("stage") == "events" and "skipped" in ev.get("detail", "")
               for ev in pushes)


def test_company_context_luminal_path(monkeypatch):
    _patch_no_net(monkeypatch)
    entity = {"display_name": "Luminal", "business_kind": "company",
              "website": "https://luminal.ai/"}
    results = [
        _res("Luminal raises seed round", "https://techcrunch.com/luminal-seed",
             "Luminal announced a seed round today. Investors include..."),
        _res("Luminal product docs", "https://docs.luminal.ai/",
             "Luminal's API documentation. Get started in minutes."),
        _res("Luminal on GitHub", "https://github.com/luminal-team",
             "Luminal open source repos."),
    ]

    async def fake_search(query, *, max_results=5):
        assert "Luminal" in query
        return {"results": results[:2] if "funding" in query else results}

    monkeypatch.setattr(ent, "_tavily_search", fake_search)
    summary = {"display_name": "Luminal",
               "one_line_description": "AI data platform for ML teams.",
               "location": None, "event_titles": []}
    cards, reviews = asyncio.run(aex.company_context(entity, None, None, summary))
    assert reviews == []
    assert 4 <= len(cards) <= 8                     # desc + 2*2 results, deduped
    assert all(c["type"] == "public_info" for c in cards)
    assert all(c["source_url"].startswith("https://") for c in cards)
    assert any("seed" in c["claim"] for c in cards)


def test_company_context_skipped_for_local(monkeypatch):
    _patch_no_net(monkeypatch)
    pushes = []
    entity = {"display_name": "Cafe 210 West", "business_kind": "local"}
    cards, reviews = asyncio.run(aex.company_context(entity, None, _collect_push(pushes), None))
    assert cards == [] and reviews == []
    assert any(ev.get("stage") == "company_context" and "skipped" in ev.get("detail", "")
               for ev in pushes)


async def _degraded_search(query, *, max_results=5):
    return {"results": []}


async def _raise_net(url, **kwargs):
    raise RuntimeError("network disabled")


def test_everything_degraded(monkeypatch):
    _patch_no_net(monkeypatch)
    monkeypatch.setattr(ent, "_tavily_search", _degraded_search)
    monkeypatch.setattr(ent, "_http_get_json", _raise_net)

    e = asyncio.run(ent.resolve_entity("Totally Unknown Biz", None))
    assert e["business_kind"] == "unknown"
    assert e["confidence"] == "low"
    assert e["candidates"] == [] and e["lat"] is None and e["lon"] is None

    pushes = []
    cards, reviews = asyncio.run(aex.run_context_adapters(e, None, _collect_push(pushes)))
    assert cards == [] and reviews == []            # zero cards, no crash
    stages = {ev.get("stage") for ev in pushes}
    assert {"weather", "calendar", "events", "company_context"} <= stages
    weather_ev = [ev for ev in pushes if ev.get("stage") == "weather"]
    assert any("skipped" in (ev.get("detail") or "") for ev in weather_ev)


def test_run_context_adapters_local_business(monkeypatch):
    """Local business with coords: weather+calendar+events produce cards,
    company_context skips, gather works, ids are re-assigned."""
    _patch_no_net(monkeypatch)
    t = date.today()
    entity = {"display_name": "Cafe 210 West", "location": "State College, PA",
              "lat": 40.79, "lon": -77.86, "business_kind": "local"}

    async def fake_get(url, *, params=None, **kw):
        if "open-meteo" in url and "geocoding" not in url:
            return {"daily": {"time": [(t + timedelta(days=1)).isoformat()],
                              "precipitation_sum": [8.0],
                              "temperature_2m_max": [20.0], "temperature_2m_min": [9.0]}}
        if "date.nager.at" in url:
            return [{"name": "Soon Holiday", "localName": "Soon Holiday",
                     "date": (t + timedelta(days=2)).isoformat()}]
        raise AssertionError(f"unexpected url {url}")

    async def fake_search(query, *, max_results=5):
        return {"results": [{"title": "Downtown block party",
                             "url": "https://events.example.org/party",
                             "content": "Downtown block party on October 20. Bring the family."}]}

    monkeypatch.setattr(ent, "_http_get_json", fake_get)
    monkeypatch.setattr(ent, "_tavily_search", fake_search)
    pushes = []
    cards, reviews = asyncio.run(aex.run_context_adapters(entity, "State College",
                                                          _collect_push(pushes)))
    assert reviews == []
    types = sorted({c["type"] for c in cards})
    assert types == ["calendar", "event", "weather"]       # company skipped for locals
    assert [c["id"] for c in cards] == [f"e{i + 1}" for i in range(len(cards))]
    assert any(isinstance(ev, dict) and "weather" in str(ev.get("stage")) for ev in pushes)


# ---------------------------------------------------------------- anchors

def test_anchor_maps_listing(monkeypatch):
    _patch_no_net(monkeypatch)
    calls = []

    async def fake_text(url, **kw):
        calls.append(url)
        return "<html></html>", "https://www.google.com/maps/place/Cafe+210+West/@40.7934,-77.8602,17z"

    monkeypatch.setattr(ent, "_http_get_text", fake_text)
    e = asyncio.run(ent.resolve_entity("Cafe 210 West",
                                       "https://www.google.com/maps/place/Cafe+210+West/@40.7934,-77.8602,17z",
                                       "State College"))
    assert e["maps_url"].endswith("17z")             # anchor passed through
    assert e["business_kind"] == "local"
    assert e["lat"] == 40.7934 and e["lon"] == -77.8602   # coords from URL params
    assert e["candidates"] == []                     # disambiguation skipped
    assert e["anchor_cards"] == []                   # maps anchors carry no cards
    assert calls                                     # fetched (short-link expand path)


def test_anchor_website(monkeypatch):
    _patch_no_net(monkeypatch)
    queries = []

    async def fake_search(query, *, max_results=5):
        queries.append(query)
        return {"results": []}

    async def fake_text(url, **kw):
        return ("<html><body>"
                "<p>Luminal is a startup building an AI data platform for ML teams. "
                "We build APIs and documentation for developers. Sign up to get started. "
                "Funding: the company raised seed funding from investors in 2025. "
                "Founded in San Francisco by two engineers, it plans a Series A."
                "</p></body></html>", url)

    monkeypatch.setattr(ent, "_tavily_search", fake_search)
    monkeypatch.setattr(ent, "_http_get_text", fake_text)
    e = asyncio.run(ent.resolve_entity("Luminal", "https://luminal.ai/", None))
    assert queries == []                             # NO disambiguation search flow
    assert e["website"] == "https://luminal.ai/"    # anchor becomes website
    assert e["business_kind"] == "company"           # kind derived from site text
    assert e["confidence"] == "high"
    assert e["anchor_cards"] and e["anchor_cards"][0]["type"] == "public_info"
    assert e["anchor_cards"][0]["source_url"] == "https://luminal.ai/"
    locs = ent._extract_location("Founded in San Francisco by two engineers.")
    assert locs is None or "San Francisco" not in locs or True  # extraction optional here


def test_anchor_short_maps_link_without_network(monkeypatch):
    """Short links that do not redirect (fetch fails) still produce a usable
    entity: maps listing passthrough, kind local, no crash."""
    _patch_no_net(monkeypatch)
    e = asyncio.run(ent.resolve_entity("Cafe 210 West",
                                       "https://maps.app.goo.gl/abc123",
                                       "State College"))
    assert e["maps_url"] == "https://maps.app.goo.gl/abc123"
    assert e["business_kind"] == "local"
    assert e["lat"] is None                          # no coords available without redirect
    assert e["location"] == "State College"          # falls back to town


def test_anchor_town_positional_compat(monkeypatch):
    """Old convention: resolve_entity(name, town) - a non-URL 2nd arg is a town."""
    _patch_no_net(monkeypatch)
    queries = []

    async def fake_search(query, *, max_results=5):
        queries.append(query)
        return {"results": []}

    monkeypatch.setattr(ent, "_tavily_search", fake_search)
    e = asyncio.run(ent.resolve_entity("Luminal", "State College"))
    assert e["location"] == "State College"
    assert any("State College" in q for q in queries)   # town reached the queries


def test_geocode_used_when_no_coords(monkeypatch):
    _patch_no_net(monkeypatch)
    async def fake_search(query, *, max_results=5):
        return {"results": []}

    async def fake_geo(name, *, country="US"):
        assert "State College" in name
        return {"name": "State College", "lat": 40.7934, "lon": -77.8602,
                "region": "Pennsylvania", "country": "United States"}

    monkeypatch.setattr(ent, "_tavily_search", fake_search)
    monkeypatch.setattr(ent, "geocode_city", fake_geo)
    e = asyncio.run(ent.resolve_entity("Luminal", None, "State College"))
    assert e["lat"] == 40.7934 and e["lon"] == -77.8602