"""Session storage, priority order at init:
1. Mongo when MONGO_URI is set and reachable;
2. DynamoDB when AWS credentials resolve via boto3's default chain
   (table 'callcrowd_sessions', PAY_PER_REQUEST, created if missing);
3. data/sessions.json — always, as the guaranteed durable floor: it is loaded
   on init and written on EVERY mutation regardless of which cloud backend
   engages.

Storage errors never 500 the API. Session docs are plain JSON-able dicts (see
main.py snapshot builder)."""
from __future__ import annotations

import asyncio
import datetime
import json
import logging
import os

log = logging.getLogger("storage")

DYNAMO_TABLE = "callcrowd_sessions"

# Default: <repo>/data/sessions.json (override with SESSIONS_FILE or by
# monkeypatching this module global in tests).
SESSIONS_FILE = (os.getenv("SESSIONS_FILE")
                 or os.path.join(os.path.dirname(os.path.dirname(
                     os.path.abspath(__file__))), "data", "sessions.json"))

# Single-threaded asyncio suffices for the file write path; this lock only
# guards the write-vs-write race across tasks (read-modify-write is fine since
# get+put happen on the same event loop without awaits in between the mutation).
_FILE_LOCK = asyncio.Lock()


class Storage:
    def __init__(self) -> None:
        self._mem: dict[str, dict] = {}
        self._col = None        # pymongo collection
        self._table = None      # boto3 DynamoDB table resource
        self._file = SESSIONS_FILE
        self._load_file()
        uri = os.getenv("MONGO_URI", "")
        if uri:
            try:
                from pymongo import MongoClient

                client = MongoClient(uri, serverSelectionTimeoutMS=2000)
                client.admin.command("ping")
                self._col = client["customer_swarm"]["sessions"]
                log.info("storage: Mongo connected")
                # merge Mongo docs into L1 (cloud is consulted on read; file
                # wins on key collision — it is written on every mutation)
                for d in list(self._col.find()):
                    sid = d.get("_id") or d.get("session_id")
                    if sid and sid not in self._mem:
                        self._mem[sid] = d
            except Exception as e:  # noqa: BLE001
                log.warning("storage: Mongo unavailable (%s); falling back to in-memory", e)
                self._col = None
        # AWS: when Mongo is primary, DynamoDB engages as the session-state
        # MIRROR (dual-write); when Mongo is absent it becomes the primary.
        self._init_dynamo()
        log.info("storage: backend engaged: %s; dynamo mode=%s (durable floor: %s)",
                 self.backend,
                 "primary" if self._col is None else "mirror", self._file)

    def _init_dynamo(self) -> None:
        """Tier 2: DynamoDB if AWS credentials resolve. Best-effort create +
        connect; any failure falls through to the file floor silently."""
        try:
            import boto3

            creds = boto3.Session().get_credentials()
            if creds is None:
                log.info("storage: no AWS credentials resolved; DynamoDB skipped")
                return
            region = os.getenv("AWS_REGION", "us-east-1")
            resource = boto3.resource("dynamodb", region_name=region)
            try:
                resource.create_table(
                    TableName=DYNAMO_TABLE,
                    KeySchema=[{"AttributeName": "session_id", "KeyType": "HASH"}],
                    AttributeDefinitions=[{"AttributeName": "session_id",
                                           "AttributeType": "S"}],
                    BillingMode="PAY_PER_REQUEST")
            except Exception:  # noqa: BLE001
                pass  # ResourceInUseException or credentials/API hiccups: best effort
            table = resource.Table(DYNAMO_TABLE)
            table.load()  # resolves the table / raises if inaccessible
            self._table = table
            log.info("storage: DynamoDB engaged (table=%s region=%s)", DYNAMO_TABLE, region)
            # merge cloud items into L1 (same collision rule: file wins)
            for item in table.scan().get("Items", []):
                sid = item.get("session_id")
                if sid and sid not in self._mem:
                    try:
                        self._mem[sid] = json.loads(item.get("doc", "{}"))
                    except Exception:  # noqa: BLE001
                        pass
        except Exception as e:  # noqa: BLE001
            log.info("storage: DynamoDB unavailable (%s); file floor remains", e)
            self._table = None

    @property
    def backend(self) -> str:
        if self._col is not None:
            return "mongo"
        if self._table:
            return "dynamodb"
        return "memory"

    # ---- durable file layer ----

    def _load_file(self) -> None:
        try:
            with open(self._file, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                self._mem.update({k: v for k, v in data.items() if isinstance(v, dict)})
            log.info("storage: loaded %d session(s) from %s", len(self._mem), self._file)
        except FileNotFoundError:
            pass
        except Exception as e:  # noqa: BLE001
            log.warning("storage: could not load %s (%s); starting fresh", self._file, e)

    def _persist_sync(self) -> None:
        tmp = self._file + ".tmp"
        os.makedirs(os.path.dirname(self._file) or ".", exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self._mem, f, ensure_ascii=False, default=str)
        os.replace(tmp, self._file)

    async def _persist(self) -> None:
        try:
            async with _FILE_LOCK:
                await asyncio.to_thread(self._persist_sync)
        except Exception as e:  # noqa: BLE001
            log.warning("storage: failed persisting to %s (%s); kept in memory",
                        self._file, e)

    async def all(self) -> dict[str, dict]:
        """All known session docs (in-memory L1, which is merged with the file
        on init and kept in sync by every mutation; cloud overlay when live)."""
        docs = dict(self._mem)
        if self._col is not None:
            try:
                for d in await asyncio.to_thread(
                        lambda: list(self._col.find())):  # noqa: B023
                    sid = d.get("_id") or d.get("session_id")
                    if sid:
                        docs[sid] = d
            except Exception as e:  # noqa: BLE001
                log.warning("storage: mongo scan failed (%s); using memory", e)
        elif self._table:
            try:
                for item in (await asyncio.to_thread(
                        lambda: self._table.scan().get("Items", []))):  # noqa: B023
                    sid = item.get("session_id")
                    if sid:
                        try:
                            docs[sid] = json.loads(item.get("doc", "{}"))
                        except Exception:  # noqa: BLE001
                            pass
            except Exception as e:  # noqa: BLE001
                log.warning("storage: dynamo scan failed (%s); using memory", e)
        return docs

    def _dynamo_item(self, session_id: str, doc: dict) -> dict:
        return {"session_id": session_id, "doc": json.dumps(doc, default=str),
                "updated_at": datetime.datetime.now(
                    datetime.timezone.utc).isoformat()}

    async def get(self, session_id: str) -> dict | None:
        if self._col is not None:
            try:
                doc = await asyncio.to_thread(
                    lambda: self._col.find_one({"_id": session_id}))  # noqa: B023
                if doc is not None:
                    return doc
            except Exception as e:  # noqa: BLE001
                log.warning("storage: mongo get failed (%s); using memory fallback", e)
        elif self._table:
            try:
                item = await asyncio.to_thread(
                    lambda: self._table.get_item(Key={"session_id": session_id})  # noqa: B023
                    .get("Item"))
                if item and item.get("doc"):
                    return json.loads(item["doc"])
            except Exception as e:  # noqa: BLE001
                log.warning("storage: dynamo get failed (%s); using memory fallback", e)
        return self._mem.get(session_id)

    async def put(self, session_id: str, doc: dict) -> None:
        doc = {**doc}
        self._mem[session_id] = doc
        await self._persist()  # file floor: always, regardless of cloud backend
        if self._col is not None:
            try:
                await asyncio.to_thread(
                    lambda: self._col.replace_one({"_id": session_id}, doc, upsert=True))  # noqa: B023
            except Exception as e:  # noqa: BLE001
                log.warning("storage: mongo put failed (%s); kept in memory", e)
        if self._table is not None:
            try:
                await asyncio.to_thread(
                    lambda: self._table.put_item(Item=self._dynamo_item(session_id, doc)))  # noqa: B023
            except Exception as e:  # noqa: BLE001
                log.warning("storage: dynamo dual-write failed (%s); kept in memory", e)

    async def update(self, session_id: str, patch: dict) -> None:
        # read-modify-write the persistent copy (L1 starts from the file's
        # contents, so this stays correct across restarts — never merge into a
        # blind empty dict that would forget older fields)
        cur = await self.get(session_id)
        if cur is None:
            return
        cur.update(patch)
        await self.put(session_id, cur)