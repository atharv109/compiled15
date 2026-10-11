"""Offline tests for the durable storage layer + login-lite + question rule.

Runs with NO API keys, NO Mongo, NO AWS: boto3 is faked, the file floor is
pointed at a tmp copy of data/sessions.json.
Run:  python -m pytest tests/test_storage_persist.py
"""
from __future__ import annotations

import asyncio
import json
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest
from fastapi import HTTPException


# ---------------------------------------------------------------- helpers

def _fresh_storage(monkeypatch, tmp_path):
    """Storage pointed at a guaranteed-empty sessions file in tmp."""
    import app.storage as st
    path = tmp_path / "sessions.json"
    monkeypatch.setattr(st, "SESSIONS_FILE", str(path))
    return st.Storage(), path


def _doc(session_id: str, **over) -> dict:
    base = {"session_id": session_id,
            "business": {"name": "Cafe 210", "town": "Westfield"},
            "evidence": [], "personas": [], "segments": [],
            "question": None, "verdict": None, "paid": False,
            "status": "ready", "created": "2026-10-11T00:00:00Z"}
    base.update(over)
    return base


# ---------------------------------------------------------------- (a) file floor

def test_put_update_persist_and_reload_roundtrip(tmp_path, monkeypatch):
    import app.storage as st
    storage, path = _fresh_storage(monkeypatch, tmp_path)

    async def flow():
        await storage.put("s_1", _doc("s_1"))
        await storage.update("s_1", {"status": "verdict_ready"})

    asyncio.run(flow())

    on_disk = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(on_disk, dict) and "s_1" in on_disk
    assert on_disk["s_1"]["status"] == "verdict_ready"

    # new instance = restart: reads the written session back
    reloaded = st.Storage()
    doc = asyncio.run(reloaded.get("s_1"))
    assert doc is not None
    assert doc["business"]["name"] == "Cafe 210"
    assert doc["status"] == "verdict_ready"
    # update() cross-restart: read-modify-write the persistent copy
    asyncio.run(reloaded.update("s_1", {"owner_email": "a@b.co"}))
    doc2 = asyncio.run(st.Storage().get("s_1"))
    assert doc2["owner_email"] == "a@b.co"
    assert doc2["status"] == "verdict_ready"  # older field survived the merge


# ---------------------------------------------------------------- fake boto3

class _FakeTable:
    def __init__(self, store):
        self.store = store

    def load(self):
        pass

    def scan(self):
        return {"Items": [{"session_id": k, "doc": json.dumps(v)}
                          for k, v in self.store.items()]}

    def get_item(self, Key):
        sid = Key["session_id"]
        if sid in self.store:
            return {"Item": {"session_id": sid, "doc": json.dumps(self.store[sid])}}
        return {}

    def put_item(self, Item):
        self.store[Item["session_id"]] = json.loads(Item["doc"])


class _FakeDynamoResource:
    def __init__(self):
        self.store = {}

    def create_table(self, **kwargs):
        return _FakeTable(self.store)

    def Table(self, name):
        return _FakeTable(self.store)


def _install_fake_boto3(monkeypatch):
    resource = _FakeDynamoResource()

    class _FakeSession:
        def get_credentials(self):
            return object()

    mod = types.ModuleType("boto3")
    mod.Session = lambda: _FakeSession()
    mod.resource = lambda service, **kw: resource
    monkeypatch.setitem(sys.modules, "boto3", mod)
    return resource


def test_backend_selection_dynamodb_with_file_floor(tmp_path, monkeypatch):
    import app.storage as st
    monkeypatch.delenv("MONGO_URI", raising=False)
    monkeypatch.setenv("AWS_REGION", "us-east-1")
    monkeypatch.setattr(st, "SESSIONS_FILE", str(tmp_path / "sessions.json"))
    fake = _install_fake_boto3(monkeypatch)

    storage = st.Storage()
    assert storage.backend == "dynamodb"  # no Mongo URI -> dynamo tier engaged

    async def go():
        await storage.put("s_d", _doc("s_d"))

    asyncio.run(go())
    # file floor ALSO received the write even though dynamo engaged
    assert (tmp_path / "sessions.json").exists()
    assert "s_d" in json.loads((tmp_path / "sessions.json").read_text(encoding="utf-8"))
    # dynamo item shape
    assert "s_d" in fake.store
    # cross-backend roundtrip through the cloud tier
    doc = asyncio.run(storage.get("s_d"))
    assert doc["business"]["town"] == "Westfield"


# ---------------------------------------------------------------- (b) login-lite

def test_login_flow(tmp_path, monkeypatch):
    import app.main as main_mod
    from app.main import _LoginReq

    storage, _ = _fresh_storage(monkeypatch, tmp_path)
    monkeypatch.setattr(main_mod, "storage", storage)

    async def go():
        await storage.put("s_a", _doc("s_a", owner_email="A@Example.com "))
        await storage.put("s_b", _doc("s_b", owner_email="other@x.io"))

    asyncio.run(go())

    out = asyncio.run(main_mod.login(_LoginReq(email="a@example.com")))
    assert out["email"] == "a@example.com"
    assert len(out["sessions"]) == 1
    s = out["sessions"][0]
    assert s["session_id"] == "s_a"
    assert s["business_name"] == "Cafe 210"
    assert s["business_town"] == "Westfield"
    assert s["status"] == "ready"
    assert "created" in s

    bad = main_mod.login(_LoginReq(email="not-an-email"))
    with pytest.raises(HTTPException) as ei3:
        asyncio.run(bad)
    assert ei3.value.status_code == 422

    none = asyncio.run(main_mod.login(_LoginReq(email="nobody@x.io")))
    assert none["sessions"] == []


def test_create_session_stamps_owner_and_snapshot(tmp_path, monkeypatch):
    import app.main as main_mod
    from app.main import CreateReq

    storage, _ = _fresh_storage(monkeypatch, tmp_path)
    monkeypatch.setattr(main_mod, "storage", storage)
    # keep the demo offline: no pipeline task actually needs to finish
    async def fake_pipeline(*a, **k):
        return
    monkeypatch.setattr(main_mod, "_run_pipeline", fake_pipeline)

    out = asyncio.run(main_mod.create_session(CreateReq(
        business_name="Cafe 210", owner_email="d@e.co", mock=True)))
    sid = out["session_id"]
    assert out["status"] == "ingesting"  # original success shape intact

    doc = asyncio.run(storage.get(sid))
    assert doc["owner_email"] == "d@e.co"
    assert doc.get("created")

    # demo without email keeps working (additive only)
    out2 = asyncio.run(main_mod.create_session(CreateReq(business_name="X", mock=True)))
    snap_doc = asyncio.run(storage.get(out2["session_id"]))
    assert out2["status"] == "ingesting"
    assert not snap_doc.get("owner_email")


# ---------------------------------------------------------------- (c) question validation

def test_question_validation(tmp_path, monkeypatch):
    import app.main as main_mod
    from app.main import QuestionReq

    storage, _ = _fresh_storage(monkeypatch, tmp_path)
    monkeypatch.setattr(main_mod, "storage", storage)
    ran = []

    async def fake_dispatch(session_id, question):
        ran.append((session_id, question))

    monkeypatch.setattr(main_mod, "_dispatch_debate", fake_dispatch)

    async def put():
        await storage.put("s_q", _doc("s_q"))

    asyncio.run(put())

    # garbage 'go' -> rejected
    with pytest.raises(HTTPException) as ei1:
        asyncio.run(main_mod.ask_question("s_q", QuestionReq(text="go")))
    assert ei1.value.status_code == 422
    assert ei1.value.detail == (
        "Give the swarm a full question — specific, at least ~8 words")

    # 4 words but <12 chars -> still rejected
    with pytest.raises(HTTPException) as ei2:
        asyncio.run(main_mod.ask_question("s_q", QuestionReq(text="a b c d")))
    assert ei2.value.status_code == 422

    # 30-char real question -> accepted, dispatch receives trimmed text
    q = "Extend weekday closing hours?"  # 29 chars, 4 words
    assert len(q) >= 12 and len(q.split()) == 4

    async def driver():
        out = await main_mod.ask_question("s_q", QuestionReq(text="  " + q + "  "))
        await asyncio.sleep(0)  # let the dispatched task run (fake = instant)
        return out

    out = asyncio.run(driver())
    assert out == {"ok": True}
    assert ran == [("s_q", q)]