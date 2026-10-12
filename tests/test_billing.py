"""Offline tests for the AWS Monetization HTTP-direct billing glue (Phase 6).
ZERO network: billing._signed_fetch is monkeypatched (FakeFetch), storage is a
fresh in-memory instance, and the entitlement TTL cache is cleared per test.
Run:  python -m pytest tests/test_billing.py -v   (from project root)
"""
from __future__ import annotations

import asyncio
import os
import sys
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest

import app.billing as billing
import app.main as main_mod
from app.main import HTTPException, QuestionReq

APP_ID = "01a12d25f9937a258ba399fa112d6034"
DEEP_DIVE = "01a12d2601487269bc012e1c454f4f5e"
ENDPOINT = "https://us-west-2.alpha.monetization.aws.dev"


class FakeFetch:
    """Stands in for the signed fetch; records (method, path, body). The
    `script` is a list of (status, payload) results or Exceptions, consumed
    per call (the last one repeats)."""

    def __init__(self, script):
        self.calls: list[tuple[str, str, dict | None]] = []
        self.script = list(script)
        self.ran = 0

    async def __call__(self, method, path, body):
        self.calls.append((method, path, body))
        step = self.script[min(self.ran, len(self.script) - 1)]
        self.ran += 1
        if isinstance(step, Exception):
            raise step
        return step


class FakeBilling:
    """Module stand-in wired into main when only behavior matters."""

    def __init__(self, configured=True, checkout=None, entitled=None):
        self._configured = configured
        self._checkout = checkout
        self._entitled = entitled

    def configured(self):
        return self._configured

    async def create_checkout_session(self, *a, **k):
        if self._checkout is None:
            raise ConnectionError("not wired in this test")
        return await self._checkout(*a, **k)

    async def is_entitled(self, *a, **k):
        return bool(self._entitled)


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    """Pay-gate tests must see the paywall: UNLOCK_FREE=1 is a LIVE .env demo
    flag — pin it off for the suite."""
    monkeypatch.setenv("UNLOCK_FREE", "0")
    billing.clear_cache()
    return None


@pytest.fixture()
def _aws_env(monkeypatch, _env):
    monkeypatch.setenv("MONETIZATION_ENDPOINT", ENDPOINT)
    monkeypatch.setenv("MONETIZATION_REGION", "us-west-2")
    monkeypatch.setenv("MONETIZATION_APP_ID", APP_ID)
    monkeypatch.setenv("MONETIZATION_STAGE", "sandbox")
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://demo.example.com")


def _doc(sid="s_b", **over):
    return {"session_id": sid, "business": {"name": "Cafe 210"}, "status": "ready",
            "question": "Should we open until 2 AM?",
            "verdict": {"recommendation": "open late", "confidence": 0.7, "rounds": [1, 2]},
            "evidence": [], "personas": [], "segments": [], "paid": False,
            "chat_free_used": 0, **over}


def _request():
    from starlette.requests import Request
    scope = {"type": "http", "scheme": "https", "server": ("demo.example.com", 443),
             "method": "GET", "headers": [], "query_string": b"", "path": "/pay"}
    return Request(scope)


def _fresh_storage(monkeypatch):
    st = main_mod.Storage()
    st._col = None
    st._table = None
    return st


# ------------------------------------------------------- env parsing / mode

def test_env_monetization_values_parsed(_aws_env):
    """The resolved .env(.monetization) values: endpoint/region/appId from the
    skill-written files, and MONETIZATION_STAGE=sandbox (the .env default)
    engages the sandbox face (scope=sandbox on every call)."""
    assert billing.config() == {
        "endpoint": ENDPOINT, "app_id": APP_ID, "region": "us-west-2",
        "service": "appmonetization", "scope": "sandbox", "mode": "sandbox"}
    assert billing.mode() == "sandbox" and billing.configured()


def test_stage_default_and_arn_parsing(monkeypatch):
    monkeypatch.setenv("MONETIZATION_ENDPOINT", ENDPOINT)
    monkeypatch.setenv("MONETIZATION_REGION", "us-west-2")
    monkeypatch.setenv("MONETIZATION_APP_ID", APP_ID)
    monkeypatch.delenv("MONETIZATION_STAGE", raising=False)
    assert billing.config()["mode"] == "live"           # no suffix -> live
    monkeypatch.setenv("MONETIZATION_APP_ID",
                       f"arn:aws:appmonetization:us-west-2:111:apps/{APP_ID}/sandbox")
    c = billing.config()
    assert c["mode"] == "sandbox" and c["app_id"] == APP_ID   # bare id, never the ARN
    monkeypatch.setenv("MONETIZATION_APP_ID",
                       f"arn:aws:appmonetization:us-west-2:111:app/{APP_ID}")
    assert billing.config()["app_id"] == APP_ID          # legacy singular parsed


def test_unconfigured_disables_quietly(monkeypatch):
    monkeypatch.delenv("MONETIZATION_APP_ID", raising=False)
    assert billing.config() is None and billing.mode() == "off"
    assert asyncio.run(billing.is_entitled("a@b.co")) is False        # fail closed
    assert asyncio.run(billing.put_event("a@b.co", "run_decision")) is False
    assert asyncio.run(billing.create_checkout_session("s1", "a@b.co")) is None


# ------------------------------------------------------- entitlement (gate)

def test_entitlement_allow_and_deny(monkeypatch, _aws_env):
    fake = FakeFetch([(200, {"decision": "ALLOW", "planId": DEEP_DIVE}),
                      (200, {"decision": "DENY", "reason": "NO_SUBSCRIPTION"})])
    monkeypatch.setattr(billing, "_signed_fetch", fake)
    billing.clear_cache()

    assert asyncio.run(billing.is_entitled("u@x.io")) is True
    billing.clear_cache()                       # the allowed check cached; refetch
    assert asyncio.run(billing.is_entitled("u@x.io")) is False
    method, path, body = fake.calls[1]
    assert method == "GET" and body is None
    assert path.startswith(f"/apps/{APP_ID}/entitlements/check?")
    q = urllib.parse.parse_qs(path.split("?", 1)[1])
    assert q["userId"] == [billing._uid("u@x.io")]
    assert q["eventType"] == ["unlock_deep_dive"]
    assert q["scope"] == ["sandbox"]


def test_entitlement_cache_hits(monkeypatch, _aws_env):
    fake = FakeFetch([(200, {"decision": "ALLOW"})])
    monkeypatch.setattr(billing, "_signed_fetch", fake)
    billing.clear_cache()
    assert asyncio.run(billing.is_entitled("u@x.io")) is True
    assert asyncio.run(billing.is_entitled("u@x.io")) is True
    assert fake.ran == 1                                     # served from cache
    billing.clear_cache()
    assert asyncio.run(billing.is_entitled("u@x.io")) is True
    assert fake.ran == 2


@pytest.mark.parametrize("step", [ConnectionError("dns down"),
                                  (500, {"decision": "ALLOW"}),
                                  (200, "not-json"),
                                  (200, {"decision": "DENY", "reason": "NO_SUBSCRIPTION"})])
def test_entitlement_fails_closed(monkeypatch, _aws_env, step):
    billing.clear_cache()
    monkeypatch.setattr(billing, "_signed_fetch", FakeFetch([step]))
    out = asyncio.run(billing.check_entitlement("u@x.io"))
    assert out["entitled"] is False and out["decision"] == "DENY"


# ------------------------------------------------------- metering (PutEvent)

def test_put_event_wire_shape(monkeypatch, _aws_env):
    fake = FakeFetch([(200, {"ok": True})])
    monkeypatch.setattr(billing, "_signed_fetch", fake)
    assert asyncio.run(billing.put_event("u@x.io", "run_decision")) is True
    method, path, body = fake.calls[0]
    assert method == "POST"
    assert path == f"/apps/{APP_ID}/events?scope=sandbox"
    assert body["userId"] == billing._uid("u@x.io")
    assert body["eventType"] == "run_decision"
    assert body["quantity"] == "1"                     # quantity is a string
    assert body["clientToken"] and body["timestamp"]   # idempotency + time
    assert isinstance(body["timestamp"], int) and body["timestamp"] > 10**9  # epoch seconds


def test_put_event_failure_is_quiet(monkeypatch, _aws_env):
    monkeypatch.setattr(billing, "_signed_fetch", FakeFetch([ConnectionError("boom")]))
    assert asyncio.run(billing.put_event("u@x.io", "unlock_deep_dive")) is False


# ------------------------------------------------------- checkout session

def test_checkout_payment_required(monkeypatch, _aws_env):
    fake = FakeFetch([(201, {"outcome": {"paymentRequired": {
        "checkoutUrl": "https://pay.example/session/x"}}})])
    monkeypatch.setattr(billing, "_signed_fetch", fake)
    out = asyncio.run(billing.create_checkout_session(
        "s_b", "u@x.io", return_url="https://demo.example/pay",
        refresh_url="https://demo.example/pay"))
    assert out["payment_url"] == "https://pay.example/session/x"
    assert out["provider"] == "aws" and out["outcome"] == "payment_required"
    assert out["mode"] == "sandbox"
    method, path, body = fake.calls[0]
    assert method == "POST"
    assert path.startswith(f"/apps/{APP_ID}/users/" + billing._uid("u@x.io") + "/checkout-sessions")
    assert urllib.parse.parse_qs(path.split("?", 1)[1])["scope"] == ["sandbox"]
    assert body["planId"] == DEEP_DIVE
    assert body["returnUrl"] and body["refreshUrl"] and body["clientToken"]


def test_checkout_other_outcomes(monkeypatch, _aws_env):
    monkeypatch.setattr(billing, "_signed_fetch", FakeFetch(
        [(200, {"outcome": {"paymentNotRequired": {"effectiveAt": "2026-10-12"}}})]))
    out = asyncio.run(billing.create_checkout_session("s_b", "u@x.io"))
    assert out["outcome"] == "payment_not_required" and out["payment_url"] is None
    monkeypatch.setattr(billing, "_signed_fetch", FakeFetch(
        [(200, {"outcome": {"planSelectionRequired": {"pricingUrl": "https://pricing"}}})]))
    out2 = asyncio.run(billing.create_checkout_session("s_b", "u@x.io"))
    assert out2["payment_url"] == "https://pricing"


def test_checkout_falls_back_on_exception(monkeypatch, _aws_env):
    monkeypatch.setattr(billing, "_signed_fetch", FakeFetch([ConnectionError("down")]))
    assert asyncio.run(billing.create_checkout_session("s_b", "u@x.io")) is None
    monkeypatch.setattr(billing, "_signed_fetch", FakeFetch([(400, {"message": "no"})]))
    assert asyncio.run(billing.create_checkout_session("s_b", "u@x.io")) is None


# ------------------------------------------------------- route wiring

def test_get_pay_prefers_aws_checkout(monkeypatch, _aws_env):
    main_mod.storage = _fresh_storage(monkeypatch)
    asyncio.run(main_mod.storage.put("s_b", _doc(owner_email="a@b.co")))
    calls = {}

    async def aws_checkout(session_id, user_id, *, return_url=None, refresh_url=None):
        calls["args"] = (session_id, user_id, return_url)
        return {"payment_url": "https://pay.example/x", "provider": "aws",
                "outcome": "payment_required", "mode": "sandbox"}

    monkeypatch.setattr(main_mod, "billing", FakeBilling(checkout=aws_checkout))
    out = asyncio.run(main_mod.get_pay("s_b"))
    assert out["payment_url"] == "https://pay.example/x"
    assert out["provider"] == "aws" and out["price"] == 19
    assert calls["args"] == ("s_b", "a@b.co",
                             "https://demo.example.com/api/sessions/s_b/pay")


def test_get_pay_falls_back_without_email(monkeypatch):
    main_mod.storage = _fresh_storage(monkeypatch)
    asyncio.run(main_mod.storage.put("s_b", _doc()))  # no owner_email
    async def boom(*a, **k):
        raise AssertionError("no identity -> no billing attempt")
    monkeypatch.setattr(main_mod, "billing", FakeBilling(checkout=boom))
    out = asyncio.run(main_mod.get_pay("s_b"))
    assert out["demo"] is True and out["payment_url"] is None
    assert out["provider"] == "stripe" and out["price"] == 19


def test_get_pay_falls_back_on_billing_failure(monkeypatch):
    main_mod.storage = _fresh_storage(monkeypatch)
    asyncio.run(main_mod.storage.put("s_b", _doc(owner_email="a@b.co")))

    async def broken(*a, **k):
        raise ConnectionError("bill down")

    monkeypatch.setattr(main_mod, "billing", FakeBilling(checkout=broken))
    out = asyncio.run(main_mod.get_pay("s_b"))
    assert out["demo"] is True and out["payment_url"] is None  # never 500
    out2 = asyncio.run(main_mod.get_pay("s_b"))
    assert out2["demo"] is True and out2["price"] == 19


def test_mark_paid_meters_unlock(monkeypatch):
    main_mod.storage = _fresh_storage(monkeypatch)
    asyncio.run(main_mod.storage.put("s_b", _doc(owner_email="a@b.co")))
    fired = []
    monkeypatch.setattr(main_mod, "_fire_meter", lambda u, e: fired.append((u, e)))
    out = asyncio.run(main_mod.mark_paid("s_b"))
    assert out == {"ok": True, "paid": True}
    assert fired == [("a@b.co", "unlock_deep_dive")]


def test_ask_question_meters_run_decision(monkeypatch):
    main_mod.storage = _fresh_storage(monkeypatch)
    asyncio.run(main_mod.storage.put("s_b", _doc(status="ready")))

    async def fake_dispatch(session_id, question):
        return None

    fired = []
    monkeypatch.setattr(main_mod, "_dispatch_debate", fake_dispatch)
    monkeypatch.setattr(main_mod, "_fire_meter", lambda u, e: fired.append((u, e)))
    asyncio.run(main_mod.ask_question(
        "s_b", QuestionReq(text="Should we stay open past midnight?")))
    assert fired == [("s_b", "run_decision")]     # session-id identity when no email


# ------------------------------------------------------- gates (chat / act)

def test_agent_chat_gate(monkeypatch):
    main_mod.storage = _fresh_storage(monkeypatch)
    cases = [
        (_doc(paid=True, chat_free_used=99), 404),            # paid flag passes gate
        (_doc(owner_email="a@b.co", chat_free_used=99), 404),  # entitlement passes gate
        (_doc(owner_email="a@b.co", chat_free_used=3), 402),   # out of free, unentitled
    ]
    for doc, expect in cases:
        main_mod.storage._mem[doc["session_id"]] = doc
        monkeypatch.setattr(main_mod, "billing",
                            FakeBilling(entitled=(expect == 404)))
        with pytest.raises(HTTPException) as hit:
            # personas list is empty: passing the gate resurfaces as 404 persona
            asyncio.run(main_mod.agent_chat("s_b", "p404", main_mod._ChatBody(message="why?")))
        assert hit.value.status_code == expect, doc


def test_entitlement_gate_helper(monkeypatch):
    doc_paid = _doc(paid=True)
    assert asyncio.run(main_mod._unlocked(doc_paid)) is True

    doc_ent = _doc(owner_email="a@b.co")
    monkeypatch.setattr(main_mod, "billing", FakeBilling(entitled=True))
    assert asyncio.run(main_mod._unlocked(doc_ent)) is True
    monkeypatch.setattr(main_mod, "billing", FakeBilling(entitled=False))
    assert asyncio.run(main_mod._unlocked(doc_ent)) is False

    # no owner email -> paid-flag gate only; billing is never consulted
    monkeypatch.setattr(main_mod, "billing", FakeBilling())
    assert asyncio.run(main_mod._unlocked(_doc(paid=False))) is False

    # billing outage -> not unlocked (fail closed), demo flow unaffected
    class _Down:
        def configured(self):
            return True

        async def is_entitled(self, *a, **k):
            raise ConnectionError("down")

    monkeypatch.setattr(main_mod, "billing", _Down())
    assert asyncio.run(main_mod._unlocked(doc_ent)) is False


def test_act_gate(monkeypatch):
    main_mod.storage = _fresh_storage(monkeypatch)
    monkeypatch.setattr(main_mod, "billing", FakeBilling(entitled=False))
    main_mod.storage._mem["s_b"] = _doc(owner_email="a@b.co")
    with pytest.raises(HTTPException) as hit:
        asyncio.run(main_mod.act_route("s_b"))
    assert hit.value.status_code == 402

    # paid flag passes the gate -> run_act is reached; stub it (no network)
    try:
        from app.llm import act as act_mod
    except ImportError:  # act module absent in this env: the 402 case is all we can assert
        return

    ran = {}

    async def fake_run_act(*a, **k):
        ran["called"] = True
        return {"actions": []}

    monkeypatch.setattr(act_mod, "run_act", fake_run_act)
    main_mod.storage._mem["s_b_paid"] = _doc(sid="s_b_paid", paid=True)
    asyncio.run(main_mod.act_route("s_b_paid"))
    assert ran["called"]


# ------------------------------------------------------- snapshot teaser gate

def test_snapshot_teaser_unlocks_on_entitlement(monkeypatch):
    main_mod.storage = _fresh_storage(monkeypatch)
    asyncio.run(main_mod.storage.put("s_b", _doc(owner_email="a@b.co")))
    monkeypatch.setattr(main_mod, "billing", FakeBilling(entitled=False))
    locked = asyncio.run(main_mod.get_session("s_b"))
    assert locked["paid"] is False
    assert "rounds" not in (locked["verdict"] or {})     # teaser stays

    billing.clear_cache()
    monkeypatch.setattr(main_mod, "billing", FakeBilling(entitled=True))
    opened = asyncio.run(main_mod.get_session("s_b"))
    assert opened["paid"] is True
    assert (opened["verdict"] or {}).get("rounds") == [1, 2]  # full verdict


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))