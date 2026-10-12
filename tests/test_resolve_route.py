"""Offline tests for the POST /api/resolve intake route. ZERO network: nothing
here hits Tavily/geocoding — app.entity.resolve_entity is monkeypatched at the
module surface (the route imports it lazily, so patches always win). The route
never touches storage or the LLM; degradations are plain 200s, never 500.
Run:  python -m pytest tests/test_resolve_route.py -v   (from project root)
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest
from fastapi.testclient import TestClient

import app.entity as entity_module
from app.main import app

client = TestClient(app)

ENTITY_KEYS = {"display_name", "business_kind", "confidence", "location",
               "candidates", "maps_url", "website", "used_anchor"}


def _patch_resolver(monkeypatch, impl):
    """The route does `from app.entity import resolve_entity` at call time —
    patching the module attribute always wins."""
    monkeypatch.setattr(entity_module, "resolve_entity", impl)


async def _anchor_impl(business_name, anchor_url=None, town=None):
    assert anchor_url and "google.com/maps" in anchor_url   # reached unchanged
    return {
        "display_name": "Cafe 210 West", "location": "State College, PA",
        "lat": 40.79, "lon": -77.86, "website": None,
        "maps_url": "https://www.google.com/maps/place/Cafe+210+West/@40.79,-77.86,17z",
        "business_kind": "local", "candidates": [], "confidence": "high",
        "anchor_cards": [],
    }


async def _ambiguous_impl(business_name, anchor_url=None, town=None):
    return {
        "display_name": "Luminal", "location": town, "lat": None, "lon": None,
        "website": "https://luminalwebsites.com/",
        "maps_url": None, "business_kind": "company", "confidence": "low",
        "candidates": [
            {"label": "Luminal AI — AI data platform", "kind": "company",
             "why": "luminal.ai: 7 relevance signal(s)"},
            {"label": "Luminal Websites", "kind": "company",
             "why": "luminalwebsites.com: 5 relevance signal(s)"},
        ],
        "anchor_cards": [],
    }


async def _boom_impl(business_name, anchor_url=None, town=None):
    raise RuntimeError("resolver exploded")


def test_anchor_resolve_passthrough_and_used_anchor(monkeypatch):
    seen = {}

    async def impl(business_name, anchor_url=None, town=None):
        seen["args"] = (business_name, anchor_url, town)
        return await _anchor_impl(business_name, anchor_url, town)

    _patch_resolver(monkeypatch, impl)
    r = client.post("/api/resolve", json={
        "business_name": "Cafe 210 West",
        "anchor_url": "https://www.google.com/maps/place/Cafe+210+West/@40.79,-77.86,17z",
        "town": "State College"})
    assert r.status_code == 200
    body = r.json()
    assert set(body) == ENTITY_KEYS
    assert body["used_anchor"] is True
    assert body["display_name"] == "Cafe 210 West"
    assert body["business_kind"] == "local"
    assert body["confidence"] == "high"
    assert body["maps_url"].endswith("17z")
    assert body["candidates"] == []
    assert seen["args"] == ("Cafe 210 West",
                            "https://www.google.com/maps/place/Cafe+210+West/@40.79,-77.86,17z",
                            "State College")


def test_ambiguous_name_only_surfaced_candidates(monkeypatch):
    _patch_resolver(monkeypatch, _ambiguous_impl)
    r = client.post("/api/resolve", json={"business_name": "Luminal",
                                          "town": "State College"})
    assert r.status_code == 200
    body = r.json()
    assert body["used_anchor"] is False
    assert len(body["candidates"]) == 2
    assert all(set(c) >= {"label", "kind", "why"} for c in body["candidates"])
    assert body["confidence"] == "low"
    assert body["maps_url"] is None


def test_resolver_failure_degrades_known_shape_never_500(monkeypatch):
    _patch_resolver(monkeypatch, _boom_impl)
    r = client.post("/api/resolve", json={"business_name": "Whatever Co",
                                          "town": "State College"})
    assert r.status_code == 200                     # never a 500 on resolver crash
    body = r.json()
    assert body["business_kind"] == "unknown"
    assert body["confidence"] == "low"
    assert body["candidates"] == []
    assert body["used_anchor"] is False
    assert body["display_name"] == "Whatever Co"    # name echo, usable UI fallback


def test_resolver_crash_returns_error_shape_with_anchor_flag(monkeypatch):
    _patch_resolver(monkeypatch, _boom_impl)
    r = client.post("/api/resolve", json={"business_name": "X", "anchor_url": "https://a.io"})
    assert r.status_code == 200
    assert r.json()["used_anchor"] is True


def test_missing_business_name_is_422():
    r = client.post("/api/resolve", json={"town": "State College"})
    assert r.status_code == 422
    r = client.post("/api/resolve", json={"business_name": "   "})
    assert r.status_code == 422                     # blank name is not a business


def test_resolver_returns_none_degrades(monkeypatch):
    """Resolver returning None (shouldn't, but the guard is the point)."""
    async def none_impl(business_name, anchor_url=None, town=None):
        return None

    _patch_resolver(monkeypatch, none_impl)
    r = client.post("/api/resolve", json={"business_name": "Ghost Biz"})
    assert r.status_code == 200
    body = r.json()
    assert body["business_kind"] == "unknown"
    assert body["display_name"] == "Ghost Biz"


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-v"]))