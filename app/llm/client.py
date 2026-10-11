"""Single OpenAI-compatible client for every lane. Pin: agents use generate()
not raw openai imports, so a provider switch is one file.

Two tiers:
- crowd lanes (gpt-4o-mini → luminal → groq): persona/debate/loop volume work.
- strong lane (gpt-5.6-sol): the judge only.
"""
from __future__ import annotations
import asyncio
import httpx
from app.config import cfg
from openai import AsyncOpenAI

def _mk_client(base: str, key: str) -> AsyncOpenAI:
    return AsyncOpenAI(base_url=base, api_key=key,
                       timeout=httpx.Timeout(120, connect=10))

class LanePool:
    """Round-robins across lanes, auto-cools dead ones. Each lane is
    (base, client, model)."""
    def __init__(self, lanes: list[tuple[str, str]]):
        self.lanes = [(b, _mk_client(b, _key_for(b)), m) for b, m in lanes]
        self._next = 0
        self._dead: set[int] = set()
        self.cooldown_until = [0.0] * len(self.lanes)

    def pick(self) -> tuple[int, AsyncOpenAI, str] | None:
        order = sorted(
            (i for i in range(len(self.lanes)) if i not in self._dead),
            key=lambda i: (self.cooldown_until[i], self._next),
        )
        if not order:
            return None
        i = order[0]
        self._next = (self._next + 1) % len(self.lanes)
        return i, self.lanes[i][1], self.lanes[i][2]

    def cool(self, i: int, seconds: float = 20.0):
        import time
        self.cooldown_until[i] = time.time() + seconds

def _is_reasoning(model: str) -> bool:
    """Reasoning models reject `max_tokens` (need max_completion_tokens) and
    the `temperature` knob on plain OpenAI."""
    return model.startswith(("gpt-5", "o1", "o3", "o4"))

def _key_for(base: str) -> str:
    if base.startswith("https://api.groq"):
        return cfg.GROQ_API_KEY
    if base.startswith("https://api.openai"):
        return cfg.OPENAI_API_KEY
    return cfg.LUMINAL_API_KEY

_crowd = LanePool(cfg.crowd_lanes())
_strong_l = LanePool([cfg.strong_lane()] if cfg.strong_lane() else [])

def _pool(prefer: str | None) -> LanePool | None:
    if prefer == "strong":
        return _strong_l
    return _crowd  # prefer in (None, "crowd", anything-else)

def _groq_json_guard(messages: list[dict]) -> list[dict]:
    if any("json" in str(m.get("content") or "").lower() for m in messages):
        return messages
    return [*messages, {"role": "system",
                        "content": "Reply ONLY with a valid JSON object (json)."}]

async def generate(
    messages: list[dict],
    *,
    temperature: float = 0.7,
    max_tokens: int = 700,
    json_mode: bool = False,
    prefer: str | None = "crowd",
) -> str | None:
    """One chat completion. prefer='crowd': crowd lanes; prefer='strong': judge
    lane. Returns None if that tier is fully unavailable (callers must fall
    back deterministically)."""
    pool = _pool(prefer)
    if pool is None:
        return None
    attempts = 0
    import time as _t
    while attempts < len(pool.lanes):
        slot = pool.pick()
        if slot is None:
            return None
        i, client, model = slot
        try:
            kw = {}
            if json_mode:
                kw["response_format"] = {"type": "json_object"}
                if pool.lanes[i][0].startswith("https://api.groq"):
                    messages = _groq_json_guard(messages)
            resp = await client.chat.completions.create(
                model=model, messages=messages, **kw, **({
                    "max_completion_tokens": max_tokens,
                } if _is_reasoning(model) else {
                    "max_tokens": max_tokens, "temperature": temperature,
                }),
            )
            return resp.choices[0].message.content
        except Exception as e:
            import logging
            logging.getLogger("llm.client").warning("lane %d model %s failed: %s",
                                                    i, model, str(e)[:400])
            pool.cool(i)
            attempts += 1
            continue
    return None

async def generate_many(
    jobs: list[dict],  # each: {"messages": [...], "temperature":?, "max_tokens":?, "json_mode":?}
    concurrency: int = None,
    prefer: str | None = "crowd",
) -> list[str | None]:
    """Parallel batch across lanes under a semaphore; order preserved."""
    sem_n = concurrency or cfg.CONCURRENCY
    sem = asyncio.Semaphore(sem_n)
    async def one(j):
        async with sem:
            return await generate(
                j["messages"],
                temperature=j.get("temperature", 0.7),
                max_tokens=j.get("max_tokens", 700),
                json_mode=j.get("json_mode", False),
                prefer=prefer,
            )
    return await asyncio.gather(*(one(j) for j in jobs))