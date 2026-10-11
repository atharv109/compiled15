"""AWS Monetization billing (HTTP-direct, Phase 6).

A small SigV4-signed client for the three runtime calls the HTTP-direct path
requires (`appmonetization` service): usage metering (PutEvent), access gating
(GetEntitlementDecision, fail-closed) and hosted checkout
(CreateSubscriptionCheckoutSession). Transport is httpx; signing is done ONLY
through botocore's SigV4Auth (the sanctioned mechanism for this path — no
hand-rolled signing).

Connection comes from env, loaded via app.config's dotenv (`.env` + the
Phase 5 §1b `.env.monetization`):
    MONETIZATION_ENDPOINT   e.g. https://us-west-2.alpha.monetization.aws.dev
    MONETIZATION_REGION     us-west-2 (fallback: derived from the endpoint host)
    MONETIZATION_APP_ID     bare app id, or a live/sandbox ARN as the SDK accepts
    MONETIZATION_STAGE      'sandbox' | 'live' override (default: derived from an
                            ARN '/sandbox' suffix, else live)
                            (MONETIZATION_APP_SUFFIX='/sandbox' is honoured too)

Degradation contract: every public op fails QUIET (returns None/False, logging
only) so caller routes fall through to the Stripe/demo flow and never 500 —
except entitlement, which fails CLOSED (DENY) per the reference, because a
fail-open gate would leak paid features during a billing outage.
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
import uuid
from urllib.parse import quote, urlencode, urlparse

import httpx

# ensures .env and .env.monetization are loaded into the environ before we read
import app.config  # noqa: F401

log = logging.getLogger("billing")

SERVICE = "appmonetization"  # signingName / arnNamespace from .monetize/sdk-config.json

# Wire constants for this app (Phase 5 configure output).
# `eventType` on the wire is the metric's sourceEventType (the code below);
# the hex ids are the server-minted metric ids, kept here for reference.
METRIC_IDS = {
    "unlock_deep_dive": "01a12d25fb427600ac01369cb0b53e52",
    "run_decision": "01a12d25fd79757c83ae0eedccb9a0ba",
}
PLAN_IDS = {
    "walkthrough": "01a12d25ff6b7a4cbe8060aca91e4230",
    "deep_dive": "01a12d2601487269bc012e1c454f4f5e",
}
EVENT_UNLOCK = "unlock_deep_dive"
EVENT_RUN_DECISION = "run_decision"
UNLOCK_PLAN = "deep_dive"

_APP_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")

# Botocore is the sanctioned signer for the HTTP-direct path.
try:
    from botocore.auth import SigV4Auth
    from botocore.awsrequest import AWSRequest
    from botocore.session import Session

    _HAS_BOTOCORE = True
except Exception:  # noqa: BLE001 — degrade: the demo flow is the fallback
    _HAS_BOTOCORE = False

# Small TTL cache so the snapshot poller and per-chat gates don't hammer the
# entitlement endpoint. Keyed (userId, eventType); only successful checks cache.
ENTITLEMENT_CACHE_TTL = 60.0
_ENTITLEMENT_CACHE: dict[tuple[str, str], tuple[float, dict]] = {}


class BillingUnavailable(Exception):
    """Raised by _signed_fetch when the client cannot engage (tests monkeypatch
    past it); public ops convert it into their quiet-degradation return."""


# ------------------------------------------------------------- connection

def _parse_identity(raw: str) -> tuple[str, str | None]:
    """(bare appId, scope-inferred-from-ARNSuffix). Never embed the ARN in the
    request path — only the bare id (per phase-6-http.md 'Scope')."""
    ident = raw.strip().rstrip("/")
    for marker in (":apps/", ":app/"):  # plural form; legacy singular accepted
        if marker in ident:
            ident = ident.split(marker, 1)[1]
    scope = None
    if ident.endswith("/sandbox"):
        ident = ident[: -len("/sandbox")]
        scope = "sandbox"
    return ident, scope


def _uid(user_id: str) -> str:
    """Service userId pattern is [A-Za-z0-9_.~-]+ — emails fail it.
    Normalize: emails -> deterministic sha1-derived id (stable per email, so
    entitlements and meters still resolve across sessions)."""
    import hashlib
    if user_id and not any(ch in user_id for ch in "@:/"):
        return user_id
    return "u_" + hashlib.sha1(user_id.lower().encode("utf-8")).hexdigest()[:24] + "x"


def config() -> dict | None:
    """Resolved connection, or None when not configured (client disabled ->
    callers fall through to the Stripe/demo branch)."""
    endpoint = (os.getenv("MONETIZATION_ENDPOINT") or "").strip().rstrip("/")
    raw = (os.getenv("MONETIZATION_APP_ID") or "").strip()
    if not endpoint or not raw:
        return None
    app_id, inferred = _parse_identity(raw)
    if not _APP_ID_RE.match(app_id):
        log.warning("billing: MONETIZATION_APP_ID has no parseable app id: %r", raw)
        return None
    if not inferred and (os.getenv("MONETIZATION_APP_SUFFIX") or "").strip() == "/sandbox":
        inferred = "sandbox"
    stage = (os.getenv("MONETIZATION_STAGE") or "").strip().lower()
    if stage not in ("sandbox", "live"):
        stage = inferred or "live"
    # region: env first (same value Phase 5 wrote to .env.monetization), else the
    # endpoint host's region label — mirroring the SDK's resolution order
    region = ((os.getenv("MONETIZATION_REGION") or "").strip()
              or (urlparse(endpoint).netloc.split(".") or [""])[0])
    return {"endpoint": endpoint, "app_id": app_id, "region": region,
            "service": SERVICE, "scope": stage, "mode": stage}


def configured() -> bool:
    return config() is not None


def mode() -> str:
    """Which face of the app the client engages: 'sandbox' or 'live'."""
    c = config()
    return c["mode"] if c else "off"


def _banner() -> None:
    c = config()
    if c:
        log.info("billing: AWS Monetization client engaged — mode=%s (scope=%s) "
                 "app=%s endpoint=%s", c["mode"], c["scope"], c["app_id"], c["endpoint"])
    else:
        log.info("billing: AWS Monetization not configured — Stripe/demo pay flow "
                 "stays the fallback")


# ------------------------------------------------------------- signing

_CACHED_CREDS: list = []  # resolved once; [] = not yet, [None] = none found


def _credentials():
    """The app's own execution role at runtime: the botocore default chain."""
    if not _HAS_BOTOCORE:
        return None
    if not _CACHED_CREDS:
        try:
            creds = Session().get_credentials()
            _CACHED_CREDS.append(creds.get_frozen_credentials() if creds else None)
            if _CACHED_CREDS[0] is None:
                log.info("billing: no AWS credentials resolved on the default chain")
        except Exception as e:  # noqa: BLE001
            log.warning("billing: AWS credential resolution failed: %s", e)
            _CACHED_CREDS.append(None)
    return _CACHED_CREDS[0]


async def _signed_fetch(method: str, path_with_query: str,
                        body: dict | None) -> tuple[int, object]:
    """One SigV4-signed JSON request to the resolved endpoint.
    Returns (status, parsed-body-or-None); raises on config/credential failure."""
    c = config()
    if c is None:
        raise BillingUnavailable("MONETIZATION_ENDPOINT / MONETIZATION_APP_ID not configured")
    creds = _credentials()
    if creds is None:
        raise BillingUnavailable("no AWS credentials on the default chain")
    url = f"{c['endpoint']}{path_with_query}"
    payload = None
    if body is not None:
        payload = json.dumps(body, separators=(",", ":")).encode("utf-8")
    req = AWSRequest(method=method, url=url, data=payload,
                     headers={"content-type": "application/json"} if payload else {})
    SigV4Auth(creds, c["service"], c["region"]).add_auth(req)
    prepared = req.prepare()
    async with httpx.AsyncClient(timeout=10.0) as client:  # short: never hang a route
        resp = await client.request(method, url, headers=dict(prepared.headers),
                                    content=payload)
    try:
        return resp.status_code, resp.json()
    except Exception:  # noqa: BLE001 — empty/error body
        return resp.status_code, None


def _path(c: dict, tail: str) -> str:
    return f"/apps/{c['app_id']}{tail}"


# ------------------------------------------------------------- runtime ops

async def create_checkout_session(session_id: str, user_id: str, *,
                                  return_url: str | None = None,
                                  refresh_url: str | None = None) -> dict | None:
    """Mint a hosted checkout session for the deep_dive plan ($19 unlock).

    Subscription checkout (CreateSubscriptionCheckoutSession), not the one-time
    op: the one-time checkout takes a cart of USAGE_PACK/ADD_ON items, but this
    unlock was authored as a *plan* (deep_dive), so the plan-based checkout is
    the correct op for it (see phase-6-http.md call 3). Returns
    {payment_url, provider: "aws", outcome, mode} or
    {payment_url: None, already_active: True, ...} when payment was not
    required — or None on ANY failure (caller falls back; never raises).
    """
    c = config()
    if c is None or not user_id:
        return None
    # The payments WAF rejects http://localhost URLs in return/refresh (verbatim
    # 403). Public base URL via PUBLIC_BASE_URL; default host is the one already
    # accepted by the seller-registration call; urn fallback when no host.
    public_base = os.getenv("PUBLIC_BASE_URL", "")
    if return_url and not return_url.startswith("http://localhost"):
        back = return_url
    elif public_base:
        back = f"{public_base.rstrip('/')}/pay/{session_id}"
    else:
        back = f"https://console.callcrowd.com/pay/{session_id}"
    body = {"planId": PLAN_IDS[UNLOCK_PLAN],
            "returnUrl": back,
            "refreshUrl": refresh_url or back,
            "clientToken": uuid.uuid4().hex}
    try:
        uid = _uid(user_id)
        path = _path(c, f"/users/{quote(uid, safe='')}/checkout-sessions"
                        f"?scope={c['scope']}")
        status, data = await _signed_fetch("POST", path, body)
        if not (200 <= status < 300) or not isinstance(data, dict):
            log.warning("checkout session mint rejected (HTTP %s)", status)
            return None
        outcome = data.get("outcome") or {}
        redirect = (outcome.get("paymentRequired")
                    or outcome.get("planSelectionRequired") or {})
        if redirect.get("checkoutUrl"):
            return {"payment_url": redirect["checkoutUrl"], "provider": "aws",
                    "outcome": "payment_required", "mode": c["mode"]}
        if redirect.get("pricingUrl"):
            return {"payment_url": redirect["pricingUrl"], "provider": "aws",
                    "outcome": "plan_selection_required", "mode": c["mode"]}
        if outcome.get("paymentNotRequired") is not None:
            return {"payment_url": None, "provider": "aws",
                    "outcome": "payment_not_required", "already_active": True,
                    "effective_at": outcome["paymentNotRequired"].get("effectiveAt"),
                    "mode": c["mode"]}
        log.warning("checkout outcome unrecognised (keys: %s)", list(outcome) or "none")
        return None
    except Exception:  # noqa: BLE001 — quiet degradation, never raise to a route
        log.exception("checkout session mint failed for %s (falling back)", session_id)
        return None


async def put_event(user_id: str, event_type: str, quantity: str | int = "1") -> bool:
    """Meter one billable event. Quiet on failure (returns False)."""
    c = config()
    if c is None or not user_id:
        return False
    user_id = _uid(user_id)
    body = {"userId": user_id,
            "eventType": event_type,
            "quantity": str(quantity),
            "clientToken": uuid.uuid4().hex,  # missing clientToken can drop the meter
            # timestamp is REQUIRED on PutEvent; the service wants epoch
            # SECONDS as an integer (ISO-8601 / ms are rejected with 400)
            "timestamp": int(time.time())}
    try:
        status, _ = await _signed_fetch(
            "POST", _path(c, f"/events?scope={c['scope']}"), body)
        if 200 <= status < 300:
            return True
        log.warning("PutEvent rejected (HTTP %s) for %s/%s", status, user_id, event_type)
        return False
    except Exception:  # noqa: BLE001 — fire-and-forget metering swallows failures
        log.warning("PutEvent failed for %s/%s (swallowed)", user_id, event_type,
                    exc_info=True)
        return False


async def check_entitlement(user_id: str,
                            event_type: str = EVENT_UNLOCK) -> dict:
    """Entitlement payload, fail-closed: exactly a 2xx with decision == 'ALLOW'
    yields entitled=True; DENY, non-2xx, timeout or a parse error all resolve
    to DENY (a user with no subscription is DENY/NO_SUBSCRIPTION server-side)."""
    c = config()
    if c is None or not user_id:
        return {"decision": "DENY", "reason": "BILLING_UNCONFIGURED", "entitled": False}
    key = (user_id, event_type)
    hit = _ENTITLEMENT_CACHE.get(key)
    if hit and hit[0] > time.monotonic():
        return {**hit[1], "cached": True}
    user_id = _uid(user_id)
    qs = urlencode({"userId": user_id, "eventType": event_type, "scope": c["scope"]})
    try:
        status, data = await _signed_fetch(
            "GET", _path(c, f"/entitlements/check?{qs}"), None)
        if (200 <= status < 300 and isinstance(data, dict)
                and isinstance(data.get("decision"), str)):
            payload = {**data, "entitled": data["decision"] == "ALLOW"}
            _ENTITLEMENT_CACHE[key] = (time.monotonic() + ENTITLEMENT_CACHE_TTL, payload)
            return payload
        log.warning("entitlement check not usable (HTTP %s) — fail closed", status)
    except Exception:  # noqa: BLE001 — fail closed, never fail open
        log.warning("entitlement check failed — fail closed", exc_info=True)
    return {"decision": "DENY", "reason": "ENTITLEMENT_CHECK_FAILED", "entitled": False}


async def is_entitled(user_id: str, event_type: str = EVENT_UNLOCK) -> bool:
    return bool((await check_entitlement(user_id, event_type))["entitled"])


def clear_cache() -> None:
    _ENTITLEMENT_CACHE.clear()


_banner()