"""Name-only entity resolution over Tavily + Open-Meteo geocoding.

resolve_entity(business_name, town) turns a bare business name (plus optional
town) into the entity dict the context adapters (app.adapters_ext) consume:
display name, location, coordinates, website, Maps URL, a local-vs-company
classification, and - when plausible candidates collide - a short candidates
list. Nothing is hardcoded: classification is keyword/URL heuristics over live
search results; geocoding is Open-Meteo's free API.

Designed for offline testing: every HTTP path goes through this module's
helpers (_http_get_json / _http_post_json, usually via _tavily_search /
geocode_city), which tests monkeypatch directly.
"""
from __future__ import annotations

import logging
import re
from urllib.parse import urlparse

import httpx

log = logging.getLogger("entity")

TAVILY_SEARCH_URL = "https://api.tavily.com/search"
GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"

# ---------------------------------------------------------------- fetch layer
# Patch points for tests: route every request through these.

async def _http_get_json(url: str, *, params: dict | None = None,
                         headers: dict | None = None, timeout: float = 15.0):
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        r = await client.get(url, params=params, headers=headers)
        r.raise_for_status()
        return r.json()


async def _http_post_json(url: str, *, json: dict | None = None,
                          headers: dict | None = None, timeout: float = 15.0):
    async with httpx.AsyncClient(timeout=timeout) as client:
        r = await client.post(url, json=json, headers=headers)
        r.raise_for_status()
        return r.json()


async def _http_get_text(url: str, *, timeout: float = 15.0) -> tuple[str, str]:
    """Fetch a URL as text; returns (body, final_url_after_redirects)."""
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True,
                                 headers={"User-Agent": "Mozilla/5.0 (compatible; CustomerSwarm/1.0)"}) as client:
        r = await client.get(url)
        r.raise_for_status()
        return r.text, str(r.url)


async def _tavily_search(query: str, *, max_results: int = 5) -> dict:
    """One Tavily search. Missing key or transport error -> empty result set
    (resolve_entity degrades to 'unknown' rather than raising)."""
    try:
        from app.config import cfg
        key = cfg.TAVILY_API_KEY
        if not key:
            return {"results": []}
        data = await _http_post_json(
            TAVILY_SEARCH_URL,
            json={"query": query, "max_results": max_results},
            headers={"Authorization": f"Bearer {key}"})
        return data if isinstance(data, dict) else {"results": []}
    except Exception as e:  # noqa: BLE001
        log.warning("tavily_search '%s' failed: %s", query[:80], e)
        return {"results": []}


# ---------------------------------------------------------------- geocoding

def _score_text(text: str) -> tuple[int, int]:
    """Kind signals over plain page text (no host hints)."""
    blob = (text or "").lower()
    local = sum(1 for w in _LOCAL_WORDS if w in blob)
    company = sum(1 for w in _COMPANY_WORDS if w in blob)
    return local, company


def _looks_like_url(s: str | None) -> bool:
    return bool(s) and s.lower().startswith(("http://", "https://"))


def _is_maps_link(url: str) -> bool:
    low = (url or "").lower()
    return ("google.com/maps" in low or "maps.google." in low
            or "maps.app.goo.gl" in low or "goo.gl/maps" in low)


def _parse_maps_coords(url: str) -> tuple[float, float] | None:
    m = (re.search(r"@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)", url or "")
         or re.search(r"[?&](?:q|ll)=(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)", url or ""))
    if not m:
        return None
    try:
        return float(m.group(1)), float(m.group(2))
    except ValueError:
        return None


async def geocode_city(name: str, *, country: str = "US") -> dict | None:
    """Open-Meteo free geocoding; returns {'name','lat','lon','region','country'}
    or None. Never raises."""
    name = (name or "").strip()
    if not name:
        return None
    params: dict = {"name": name, "count": 1}
    if country:
        params["country"] = country
    try:
        data = await _http_get_json(GEOCODE_URL, params=params)
    except Exception as e:  # noqa: BLE001
        log.warning("geocode='%s' failed: %s", name, e)
        return None
    results = (data or {}).get("results") or []
    if not results:
        return None
    r0 = results[0]
    return {"name": r0.get("name"), "lat": r0.get("latitude"),
            "lon": r0.get("longitude"), "region": r0.get("admin1"),
            "country": r0.get("country")}


# ---------------------------------------------------------------- signals

_LOCAL_HOSTS = (
    "maps.google.", "google.com/maps", "yelp.com", "tripadvisor.",
    "opentable.", "doordash.com", "grubhub.com", "ubereats.com",
    "facebook.com", "resy.com")
_LOCAL_WORDS = (
    "restaurant", "cafe", "coffee shop", "bakery", "bar &", "salon", "diner",
    "brewery", "pizzeria", "menu", "open now", "hours", "reservations",
    "directions", "order online", "located at", "stars", "reviews )",
    "( reviews", "reviews)", "suite")
_COMPANY_HOSTS = (
    "crunchbase.com", "linkedin.com/company", "github.com", "producthunt.com",
    "wellfound.com", "angellist.com", "techcrunch.com", "pitchbook.com",
    "ycombinator.com", "bloomberg.com/profiles", "npmjs.com/package",
    "pypi.org/project", "dev.to", "tracxn.com", "getlatka.com")
_COMPANY_WORDS = (
    "series a", "series b", "series c", "seed round", "seed funding",
    "raised ", "funding", "investors", "venture", "startup", "saas ", "api",
    "our product", "we build", "we're building", "we are building",
    "founded by", "founded in", "headquarters", "sign up", "get started",
    "documentation", "developers", "open source", "software company",
    "tech company", "b2b", "pip install", "npm install", "backed by")
_LISTING_HOSTS = _LOCAL_HOSTS + _COMPANY_HOSTS
# profile hosts: third-party company profiles / funding press - the strongest
# "this page is a profile of a company with this name" signal
_PROFILE_HOSTS = ("crunchbase.com", "tracxn.com", "pitchbook.com",
                  "linkedin.com/company", "techcrunch.com", "ycombinator.com",
                  "getlatka.com", "preqin.com", "forbes.com", "bloomberg.com/profiles")

# "City, ST" (anchored on a zip when present; loose pass as fallback)
_ZIP_STATE_RE = re.compile(
    r"\b([A-Z][A-Za-z .'-]{2,28}),\s+(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|"
    r"IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|"
    r"PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\s+\d{5}\b")
_STATE_RE = re.compile(
    r"\b([A-Z][A-Za-z .'-]{2,28}),\s+(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|"
    r"IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|"
    r"PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b")


def _brand_tokens(name: str) -> list[str]:
    toks = [t for t in re.findall(r"[a-z0-9]+", (name or "").lower()) if len(t) >= 2]
    return toks or [(name or "").lower().strip()]


def _domain(url: str) -> str:
    try:
        h = urlparse(url).netloc.lower()
    except Exception:  # noqa: BLE001
        return (url or "")[:40]
    if h.startswith("www."):
        h = h[4:]
    return h or url[:40]


def _clean_title(title: str, fallback: str) -> str:
    t = (title or "").strip()
    for sep in (" | ", " — ", " - ", " · "):
        if sep in t:
            t = t.split(sep)[0].strip()
    t = re.sub(r"\s+[-–—]\s*(Home|Official( Site)?|About( Us)?)\s*$", "", t).strip()
    return t[:80] or fallback


def _score_result(res: dict) -> tuple[int, int]:
    url = (res.get("url") or "").lower()
    content = (res.get("content") or "").lower()
    blob = url + " " + content
    local = (2 * sum(1 for h in _LOCAL_HOSTS if h in url)
             + sum(1 for w in _LOCAL_WORDS if w in blob))
    company = (2 * sum(1 for h in _COMPANY_HOSTS if h in url)
               + sum(1 for w in _COMPANY_WORDS if w in blob))
    return local, company


def _is_maps_url(url: str) -> bool:
    low = (url or "").lower()
    if "maps.app.goo.gl" in low or "goo.gl/maps" in low:
        return True
    # exclude Maps "about"/product-pages that merely share the URL prefix
    if ("maps/about" in low or "maps-products" in low
            or "mapsplatform.google" in low):
        return False
    return ("google.com/maps/place" in low or "google.com/maps/search" in low
            or "google.com/maps/dir" in low or "google.com/maps?" in low
            or "maps.google." in low)


def _is_listing(url: str) -> bool:
    low = (url or "").lower()
    return any(h in low for h in _LISTING_HOSTS)


def url_path(url: str) -> str:
    try:
        return urlparse(url).path.lower()
    except Exception:  # noqa: BLE001
        return ""


def _token_site(results: list[dict], tokens: list[str]) -> str | None:
    """The business's own site: first non-listing URL whose DOMAIN carries a
    brand token, preferring pure-brand domains. None when every candidate URL
    is a third-party listing."""
    for r in results:
        u = (r.get("url") or "").strip()
        if not u or _is_listing(u):
            continue
        if any(t in _domain(u) for t in tokens) and _pure_brand_domain(_domain(u), tokens):
            return u
    for r in results:
        u = (r.get("url") or "").strip()
        if not u or _is_listing(u):
            continue
        if any(t in _domain(u) for t in tokens):
            return u
    return None


def _pure_brand_domain(domain: str, tokens: list[str]) -> bool:
    """True when the (registered) domain is (almost exactly) the brand name
    itself - 'luminal.ai' or 'docs.luminalai.com' pass; 'luminalwebsites.com'
    (the brand plus unrelated words) does not, because a same-name trap is
    likely. Subdomain labels like 'docs' are ignored."""
    labels = [l for l in (domain or "").lower().split(".") if l]
    core = ".".join(labels[-2:]) if len(labels) >= 2 else (domain or "").lower()
    rest = re.sub(r"[^a-z]", "", core)
    for t in tokens:
        rest = rest.replace(t, "")
    return len(rest) <= 3


def _extract_location(content: str) -> str | None:
    m = _ZIP_STATE_RE.search(content or "")
    if not m:
        m = _STATE_RE.search(content or "")
    if m:
        return f"{m.group(1).strip()}, {m.group(2)}"
    m = re.search(r"\bbased in ([A-Z][\w .'-]{2,40})", content or "")
    if m:
        return m.group(1).strip().split(".")[0][:60]
    return None


# ---------------------------------------------------------------- resolver

async def resolve_entity(business_name: str,
                         anchor_url: str | None = None,
                         town: str | None = None) -> dict:
    """Name-only (or anchored) entity resolution.

    anchor_url (when the user pastes a Maps listing or official website URL)
    is AUTHORITATIVE: no disambiguation search flow runs; the dict is derived
    from the URL (and, for website anchors, its homepage text). Note for
    backwards compatibility: if a plain town string is passed as the 2nd
    positional argument (the pre-anchor calling convention), it is treated as
    `town` instead of an anchor.

    Returns: {display_name, location, lat, lon, website, maps_url,
    business_kind ('local'|'company'|'unknown'), candidates (<=3, ambiguous
    name-search path only), confidence, anchor_cards}. anchor_cards are
    public_info EvidenceCard dicts derived from an anchored website's homepage
    text (empty for maps anchors - the scraper sidecar owns those reviews)."""
    name = (business_name or "").strip()
    town = ((town or "").strip() or None)
    anchor = ((anchor_url or "").strip() or None)
    if anchor and not _looks_like_url(anchor):
        # compatibility: town passed positionally into the anchor slot
        town = town or anchor
        anchor = None
    if anchor:
        return await _resolve_from_anchor(name, anchor, town)

    queries = [
        f"{name} {town} company about" if town else f"{name} company about",
        f"{name} {town} google maps" if town else f"{name} google maps",
    ]
    results: list[dict] = []
    for q in queries:
        data = await _tavily_search(q, max_results=6)
        results.extend(data.get("results") or [])
    results = _dedupe_by_url(results)
    tokens = _brand_tokens(name)
    website = _token_site(results, tokens)
    if results and not website:
        # optional 3rd call: results exist but no brand-domain own-site showed up
        data = await _tavily_search(f"{name} website", max_results=4)
        results = _dedupe_by_url(results + (data.get("results") or []))
        website = _token_site(results, tokens)

    groups = _group_results(results, tokens)
    ordered = sorted(groups.values(),
                     key=lambda g: (-(g["local"] + g["company"]), g["domain"]))
    maps_urls = sorted(
        [u for u in (r.get("url") or "" for r in results) if _is_maps_url(u)],
        key=lambda u: 0 if ("place" in u or "place_id" in u or url_path(u) == "dir") else 1)
    maps_url = maps_urls[0] if maps_urls else None
    local_total = sum(g["local"] for g in groups.values())
    company_total = sum(g["company"] for g in groups.values())

    conflict = (local_total >= 2 and company_total >= 2
                and min(local_total, company_total) * 3 >= max(local_total, company_total))
    if company_total >= 2 and company_total > local_total:
        kind = "company"
    elif local_total >= 2 and local_total > company_total:
        kind = "local"
    elif conflict:
        kind = "company" if company_total >= local_total else "local"
    else:
        kind = "unknown"

    # Ambiguity: local-vs-company signals collide; the only brand-token own
    # site is impure (name-trap risk, e.g. "Luminal Websites" vs "Luminal");
    # or several distinct brand titled company profiles with no own site found
    # (could be two unrelated companies with the same name).
    pure_site = bool(website and _pure_brand_domain(_domain(website), tokens))
    brand_titled = [g for g in groups.values()
                    if any(t in (g["title"] or "").lower() for t in tokens)]
    ambiguous = conflict or (website is not None and not pure_site) or (
        not website and len([g for g in brand_titled if g["company"] >= 1]) >= 2)
    if ambiguous:
        candidates = []
        for g in ordered[:3]:
            if (g["local"] + g["company"]) < 1:
                continue
            gk = ("local" if g["local"] > g["company"]
                  else "company" if g["company"] > g["local"] else "unknown")
            candidates.append({
                "label": _clean_title(g["title"], name),
                "kind": gk,
                "why": f"{g['domain']}: {g['local'] + g['company']} relevance signal(s)",
            })
    elif kind == "unknown" and any((g["local"] + g["company"]) >= 2
                                   for g in groups.values()):
        candidates = [{"label": _clean_title(g["title"], name),
                       "kind": "local" if g["local"] >= g["company"] else "company",
                       "why": f"{g['domain']}: {g['local'] + g['company']} relevance signal(s)"}
                      for g in ordered[:3] if (g["local"] + g["company"]) >= 2]
    else:
        candidates = []

    def _primary_key(g):
        hint = any(t in (g["title"] or "").lower() for t in tokens)
        return (int(g["profile"]), int(g["brand_in_url"]), int(hint),
                g["local"] + g["company"], -len(g["domain"]))

    primary = max(ordered, key=_primary_key) if ordered else None
    display_name = _clean_title(primary["title"], name) if primary else name

    location = town
    if not location:
        sources = ([primary["content"]] if primary else []) + [
            g["content"] for g in sorted(groups.values(), key=_primary_key, reverse=True)
            if g is not primary and g["content"]]
        for src in sources:
            location = _extract_location(src)
            if location:
                break

    lat = lon = None
    if location:
        geo = await geocode_city(location.split(",")[0].strip())
        if geo and geo.get("lat") is not None and geo.get("lon") is not None:
            lat, lon = geo["lat"], geo["lon"]

    confidence = ("high" if kind in ("local", "company") and not ambiguous
                  and (website or maps_url) else "low")

    return {
        "display_name": display_name,
        "location": location,
        "lat": lat,
        "lon": lon,
        "website": website,
        "maps_url": maps_url,
        "business_kind": kind,
        "candidates": candidates,
        "confidence": confidence,
        "anchor_cards": [],
    }


async def _resolve_from_anchor(name: str, anchor: str, town: str | None) -> dict:
    """Authoritative anchor path: Maps short/canonical links -> local listing
    (coords parsed from the URL, reviews left to the scraper sidecar); any
    other URL -> the business website, whose homepage text yields public_info
    cards + location/kind signals. No disambiguation, no Tavily name search."""
    maps = _is_maps_link(anchor)
    text, final_url = "", anchor
    coords = _parse_maps_coords(anchor)
    try:
        # follows redirects: short links land on the canonical Maps place URL
        text, final_url = await _http_get_text(anchor)
        text = _strip_html(text)
        if maps:
            coords = coords or _parse_maps_coords(final_url)
            text = ""  # Maps HTML is junk for scoring; skip it
    except Exception as e:  # noqa: BLE001
        log.warning("anchor fetch %s failed: %s", anchor[:60], e)

    if maps:
        kind = "local"
        website = None
        maps_url = final_url if _is_maps_link(final_url) else anchor
    else:
        local_s, company_s = _score_text(text)
        if company_s >= 2 and company_s >= local_s:
            kind = "company"
        elif local_s >= 2 or (local_s >= 1 and local_s >= company_s):
            kind = "local"
        elif company_s >= 1 and local_s == 0 and len(text) >= 300:
            kind = "company"   # authoritative anchor + real site text + product nav
        else:
            kind = "unknown"
        website = final_url if text else anchor
        maps_url = None

    location = town or _extract_location(text)
    lat = lon = None
    if coords:
        lat, lon = coords
    elif location:
        geo = await geocode_city(location.split(",")[0].strip())
        if geo and geo.get("lat") is not None and geo.get("lon") is not None:
            lat, lon = geo["lat"], geo["lon"]

    display_name = name or _clean_title(_domain(anchor), "web")
    cards = [] if maps else _anchor_cards_from_text(text, anchor, name)
    return {
        "display_name": display_name,
        "location": location,
        "lat": lat,
        "lon": lon,
        "website": website,
        "maps_url": maps_url,
        "business_kind": kind,
        "candidates": [],              # authoritative anchor: no ambiguity flow
        "confidence": "high" if kind in ("local", "company") else "low",
        "anchor_cards": cards,
    }


def _strip_html(html: str) -> str:
    import html as _html
    html = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", html)
    text = re.sub(r"(?s)<[^>]+>", " ", html)
    return re.sub(r"\s+", " ", _html.unescape(text)).strip()


def _anchor_cards_from_text(text: str, source_url: str, name: str) -> list[dict]:
    """Up to 3 public_info cards from the most substantive homepage chunks."""
    text = _strip_html(text or "")
    if not text:
        return []
    sentences = re.split(r"(?<=[.!?])\s+", text)
    chunks, cur = [], ""
    for s in sentences:
        cur = (cur + " " + s).strip()
        if len(cur) >= 120:
            chunks.append(cur)
            cur = ""
    if cur and len(cur) >= 60:
        chunks.append(cur)
    cards = []
    for chunk in chunks[:3]:
        cards.append({
            "id": f"anchor{len(cards) + 1}",
            "claim": chunk.split(". ")[0][:180] if ". " in chunk else chunk[:180],
            "source_url": source_url,
            "source_label": f"{name} website"[:80] or "Company website",
            "type": "public_info",
            "quote": chunk[:400],
        })
    return cards


def _dedupe_by_url(results: list[dict]) -> list[dict]:
    out, seen = [], set()
    for r in results:
        u = (r.get("url") or "").strip()
        if u and u in seen:
            continue
        seen.add(u)
        out.append(r)
    return out


def _group_results(results: list[dict], tokens: list[str]) -> dict[str, dict]:
    groups: dict[str, dict] = {}
    for res in results:
        url = res.get("url") or ""
        d = _domain(url)
        local, company = _score_result(res)
        g = groups.setdefault(d, {
            "domain": d, "title": res.get("title") or "", "content": "",
            "site_url": None, "local": 0, "company": 0, "brand_match": False,
            "brand_in_url": False, "profile": False,
        })
        g["local"] += local
        g["company"] += company
        content = (res.get("content") or "").strip()
        if content and not g["content"]:
            g["content"] = content
        title = res.get("title") or ""
        if title and not title.lower().startswith(("http://", "https://")) and not g["title"]:
            g["title"] = title
        blob = (title + " " + url + " " + content).lower()
        if any(t in blob for t in tokens):
            g["brand_match"] = True
        if not g["brand_in_url"] and any(
                t in url.lower().replace("+", " ").replace("-", " ")
                for t in tokens):
            g["brand_in_url"] = True
        low_url = url.lower()
        for h in _PROFILE_HOSTS:
            if h in low_url:
                g["profile"] = True
                break
        if g["site_url"] is None and url and not _is_listing(url):
            g["site_url"] = url
    return groups