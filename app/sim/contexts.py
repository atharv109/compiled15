"""Scenario contexts DERIVED from detected evidence (events / weather /
calendar / competitor / public-info cards) instead of the hardcoded
football-calendar set.

Flow (anti-hardcoding, mirrors truth.py's anti-circularity shape):
  1. derive_contexts(evidence, reviews, business_class, seed) -> ONE cheap LLM
     call (json_mode) that maps the detected evidence into scenario contexts.
     No key / unusable response -> deterministic fallback mapping, so the flow
     never raises on LLM failure and stays offline-testable.
  2. The returned dict plugs straight into loop.run_loop / eval.final_eval as
     `contexts_override` (keys "train" / "test").

Return shape:
  {
    "version": 1,
    "source": "llm" | "fallback",
    "business_class": str,
    "seed": int,
    "evidence_used": int,
    "train": [context, ...],        # 0-6 tailored (+ classic set when fallback)
    "test":  [context, ...],        # 0-2 held-out
  }
  context = {
    "name": str (snake_case, unique),
    "signal": str (the evidence claim; names the lever it amplifies),
    "multiplier_by_param": {"game_day": f, "late_night": f, "price": f, "traffic": f},
    "occurs_in": "train" | "test",
  }

Multiplier semantics vs a normal week (enforced by market.simulate's clamps):
- game_day   : scales the truth's per-segment latent event surge AND the promo
               lever's amplitude (0.0 = the context does not touch it;
               0.5-3.0 when it does) -> the "promo/event amplification" lever.
- late_night : scales the payoff of staying open late  (0.5x - 3.0x).
- price      : scales customers' price sensitivity     (0.5x - 3.0x).
- traffic    : scales total visits in the scenario     (0.5x - 3.0x).

Determinism: evidence is sorted before the prompt, and every post-processing
decision (slug dedupe, train/test caps, held-out promotion) is pinned to
random.Random(f"derive_contexts|{evidence_fingerprint}|{seed}"). The LLM lane
itself cannot be force-seeded through app.llm.client, so the LLM path uses
temperature 0.2 + sorted input and the names come from evidence-anchored
slugs; the fallback path is fully deterministic per (evidence, seed).
"""
from __future__ import annotations

import hashlib
import json
import random
import re

from app.llm import client as llm_client

PARAMS = ("game_day", "late_night", "price", "traffic")

_CLASSIC_TRAIN = ("game_day", "finals_week", "summer")
_CLASSIC_TEST = ("playoff_weekend", "new_competitor")
_RESERVED = frozenset(("normal",) + _CLASSIC_TRAIN + _CLASSIC_TEST)

_TRAIN_MAX = 6          # spec target 3-6 tailored train contexts
_TEST_MAX = 2           # 1-2 held-out
_FALLBACK_EVENT_CAP = 4
_MULT_GD = (0.0, 3.0)   # game_day: 0 = does not touch the surge/promo lever
_MULT_OTHER = (0.5, 3.0)


# ------------------------------------------------------------------ helpers

def _field(card, *keys) -> str:
    """Tolerate dict cards (and pydantic-ish objects) when pulling a field."""
    for key in keys:
        if isinstance(card, dict):
            got = card.get(key)
        else:
            got = getattr(card, key, None)
        if got:
            return str(got)
    return ""


def _normalised_evidence(evidence) -> list[dict]:
    cards = []
    for ev in evidence or []:
        ctype = _field(ev, "type", "card_type").strip().lower()
        claim = _field(ev, "claim", "text").strip()
        if not claim:
            continue
        cards.append({"type": ctype or "public_info",
                      "claim": " ".join(claim.split())})
    cards.sort(key=lambda c: (c["type"], c["claim"].lower()))
    return cards


def _slugify(text: str, used: set[str]) -> str:
    words = re.findall(r"[a-z0-9]+", text.lower())[:4] or ["scenario"]
    base = "_".join(words)
    name, i = base, 2
    while name in _RESERVED or name in used:
        name = f"{base}_{i}"
        i += 1
    used.add(name)
    return name


def _neutral_mbp() -> dict:
    return {p: (0.0 if p == "game_day" else 1.0) for p in PARAMS}


def _mk_ctx(name: str, signal: str, occurs_in: str, **mbp) -> dict:
    mult = _neutral_mbp()
    for k, v in mbp.items():
        if k in PARAMS:
            mult[k] = v
    return {"name": name, "signal": signal,
            "multiplier_by_param": {p: round(mult[p], 3) for p in PARAMS},
            "occurs_in": occurs_in}


def _clamp_mult(value, lo_hi: tuple[float, float], default: float) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        v = default
    if v != v:                      # NaN
        v = default
    return round(max(lo_hi[0], min(lo_hi[1], v)), 4)


def _clamped_mbp(raw) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    out = {}
    for p in PARAMS:
        default = 0.0 if p == "game_day" else 1.0
        lo = _MULT_GD if p == "game_day" else _MULT_OTHER
        out[p] = _clamp_mult(raw.get(p, default), lo, 0.0 if p == "game_day" else 1.0)
    return out


def _promote_heldout(train: list[dict], test: list[dict], rng) -> None:
    """final_eval needs >=1 held-out scenario; promote one deterministically."""
    if not test and len(train) >= 2:
        idx = rng.randrange(len(train))
        moved = dict(train.pop(idx))
        moved["occurs_in"] = "test"
        test.append(moved)


# ------------------------------------------------------------------ fallback

def _fallback_contexts(cards: list[dict], business_class: str,
                       rng) -> tuple[list[dict], list[dict]]:
    """LLM down / unusable. Spec mapping: event -> 1.5x demand context,
    weather -> 0.7x late-night, calendar -> 1.2x promo (game_day multiplier is
    the promo lever), and ALWAYS the classic hardcoded set demoted to fallback
    contexts for business_class local_consumer only."""
    used: set[str] = set(_RESERVED)
    train: list[dict] = []
    test: list[dict] = []
    got_event, got_weather, got_calendar = 0, False, False
    for card in cards:
        ctype, claim = card["type"], card["claim"]
        if ctype == "event" and got_event < _FALLBACK_EVENT_CAP:
            got_event += 1
            train.append(_mk_ctx(_slugify(claim, used), claim, "train",
                                 game_day=1.5, traffic=1.5))
        elif ctype == "weather" and not got_weather:
            got_weather = True
            train.append(_mk_ctx(_slugify("weather_" + claim, used), claim,
                                 "train", late_night=0.7))
        elif ctype == "calendar" and not got_calendar:
            got_calendar = True
            train.append(_mk_ctx(_slugify(claim + "_closures", used), claim,
                                 "train", game_day=1.2))
        elif ctype == "competitor" and len(test) < _TEST_MAX:
            test.append(_mk_ctx("new_competitor", claim + " (held-out)",
                                "test", price=1.6, traffic=0.85))

    klass = getattr(business_class, "value", business_class)
    if str(klass) == "local_consumer":
        for name in _CLASSIC_TRAIN:
            train.append(_mk_ctx(name, name + " (classic fallback scenario)",
                                 "train"))
        for name in _CLASSIC_TEST:
            if not any(c["name"] == name for c in test):
                test.append(_mk_ctx(name, name + " (classic fallback scenario)",
                                    "test"))

    _promote_heldout(train, test, rng)
    return train, test


# ------------------------------------------------------------------ llm path

def _messages(cards: list[dict], reviews: list[dict], business_class: str,
              seed: int) -> list[dict]:
    ev_lines = "\n".join(f"- [{c['type']}] {c['claim']}" for c in cards[:14])
    review_dicts = [r for r in (reviews or [])
                    if isinstance(r, dict) and _field(r, "text", "review")]
    review_lines = "\n".join(
        f"[{_field(r, 'segment_hint') or '?'}] "
        f"({_field(r, 'text', 'review')[:90]})"
        for r in review_dicts[:10])
    return [
        {"role": "system", "content":
            "You map detected evidence into demand-scenario contexts for a "
            "mock market simulator. Respond with JSON only."},
        {"role": "user", "content": f"""Business class: {business_class}
Detected evidence for this business (claims are one sentence each):
{ev_lines or "(none)"}

A few review snippets (tone/segments only):
{review_lines or "(none)"}

Build this business's DEMAND-SCENARIO contexts FROM the evidence above — not
from any fixed calendar. A context is one demand-shifting scenario the market
can simulate; it must amplify one of the three levers (late hours / promo /
pricing) and/or traffic. Scenario RNG seed (for stability): {seed}

Multiplier semantics vs a normal week, all clamped, stay inside the bands:
- game_day: scales the latent event surge and the promo lever (0.0 = this
  context does not touch it; 0.5-3.0 when it does)
- late_night: scales the payoff of staying open late (0.5-3.0)
- price: scales customers' price sensitivity (0.5-3.0)
- traffic: scales total visits (0.5-3.0)

Return 3-6 train contexts (occurs_in "train") plus 1-2 held-out test contexts
(occurs_in "test") the loop never trains on — an event you suspect, or a
synthetic new_competitor derived from a competitor card. Names: short
snake_case. Signal: the exact evidence claim that justifies it, naming the
lever it amplifies.

JSON exactly:
{{"contexts": [{{"name": "snake_case_name", "signal": "...",
  "multiplier_by_param": {{"game_day": 0.0, "late_night": 1.0, "price": 1.0,
                            "traffic": 1.0}},
  "occurs_in": "train"}}]}}"""},
    ]


def _validated_contexts(parsed: dict, rng) -> tuple[list[dict], list[dict]]:
    contexts = parsed.get("contexts") if isinstance(parsed, dict) else None
    if not isinstance(contexts, list):
        return [], []
    used: set[str] = set()
    train: list[dict] = []
    test: list[dict] = []
    for c in contexts:
        if not isinstance(c, dict):
            continue
        occurs = "test" if str(c.get("occurs_in") or "").strip().lower() == "test" \
            else "train"
        signal = " ".join(str(c.get("signal") or "").split())[:200]
        raw_name = str(c.get("name") or "").strip()
        train_or_test = test if occurs == "test" else train
        if occurs == "train" and len(train) >= _TRAIN_MAX:
            continue
        if occurs == "test" and len(test) >= _TEST_MAX:
            continue
        train_or_test.append({
            "name": _slugify(raw_name or signal or "scenario", used),
            "signal": signal or raw_name or "scenario",
            "multiplier_by_param": _clamped_mbp(c.get("multiplier_by_param")),
            "occurs_in": occurs,
        })
    train = train[:_TRAIN_MAX]
    test = test[:_TEST_MAX]
    _promote_heldout(train, test, rng)
    return train, test


# ------------------------------------------------------------------ entry

async def derive_contexts(evidence: list[dict], reviews: list[dict],
                          business_class: str, seed: int) -> dict:
    """Detected evidence -> train/test scenario contexts. ONE cheap LLM call;
    deterministic fallback whenever the LLM is down or its reply is unusable.

    The returned dict is directly usable as loop.run_loop / eval.final_eval's
    `contexts_override`.
    """
    cards = _normalised_evidence(evidence)
    fingerprint = hashlib.sha256(
        json.dumps(cards, sort_keys=True).encode("utf-8")).hexdigest()
    rng = random.Random(f"derive_contexts|{fingerprint}|{int(seed)}")

    raw = await llm_client.generate(
        _messages(cards, reviews, business_class, int(seed)),
        temperature=0.2,
        max_tokens=700,
        json_mode=True,
    )

    import re as _re  # noqa: F811 - keep the regex use self-evident here
    parsed: dict = {}
    if raw:
        match = _re.search(r"\{.*\}", raw, _re.S)
        if match:
            try:
                got = json.loads(match.group(0))
                parsed = got if isinstance(got, dict) else {}
            except (ValueError, TypeError):
                parsed = {}
    train, test = _validated_contexts(parsed, rng) if parsed else ([], [])
    if not train:
        train, test = _fallback_contexts(cards, business_class, rng)

    return {
        "version": 1,
        "source": "llm" if parsed and train else "fallback",
        "business_class": str(getattr(business_class, "value", business_class)),
        "seed": int(seed),
        "evidence_used": len(cards),
        "train": train,
        "test": test,
    }