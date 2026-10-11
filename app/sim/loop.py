"""Self-improvement loop: propose -> simulate -> reflect -> keep only improvements.

Round 0 is a baseline (agents see reviews + EMPTY beliefs). Rounds 1..N:
all personas propose a SimDecision + per-segment visit predictions in
PARALLEL, the aggregator combines them, the market simulates, prediction
error is scored per segment, then a reflection LLM call rewrites shared
belief notes PER SEGMENT (capped ~120 words). The rewritten beliefs are
kept IFF mean train regret dropped; otherwise the previous beliefs stand.

The only LLM usage is proposals + reflection (via app.llm.client.generate /
generate_many). With no keys the same flow runs offline on heuristic
proposals and skipped reflection, so everything stays testable.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import uuid

from app.models import Persona, RoundScore, SimDecision
from app.sim.market import (HOUR_GRID, PRICE_GRID, PROMO_GRID, grid_best,
                            regret_of, simulate)
from app.llm import client as llm_client

_BELIEF_WORD_CAP = 120
_RUN_STATE: dict[str, dict] = {}   # run_id -> {"final_decision": SimDecision, ...}


# ------------------------------------------------------------------ LLM glue

async def _ask_many(jobs: list[dict]) -> list[str | None]:
    return await llm_client.generate_many(jobs)


def _extract_json(text: str) -> dict:
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        return {}
    try:
        data = json.loads(match.group(0))
        return data if isinstance(data, dict) else {}
    except (ValueError, TypeError):
        return {}


def _clip_words(text: str, cap: int = _BELIEF_WORD_CAP) -> str:
    words = text.split()
    return " ".join(words[:cap])


# ------------------------------------------------------------------ proposals

def _heuristic_proposal(persona: Persona, segments: list[str],
                        beliefs: dict, salt: str) -> dict:
    """Offline stand-in when no LLM lanes are reachable. Rules from the
    persona's own segment name + a stable hash; never touches the truth."""
    seg = persona.segment.lower()
    h = int(hashlib.sha256(
        f"{persona.id}|{salt}".encode()).hexdigest()[:8], 16)
    promo = "none"
    hour = 22
    price = 0
    if any(k in seg for k in ("student", "grad", "college")):
        promo = "student_deal"
        price = -10
    if any(k in seg for k in ("game", "tailgate", "alumni", "fan")):
        promo = "game_day_special"
        hour = 25
    if any(k in seg for k in ("family", "parent", "tourist", "older", "regular")):
        price = 5
    if beliefs and any(b.strip() for b in beliefs.values()):
        hour = max(21, min(26, hour + (h % 3) - 1))
    return {
        "price_change_pct": price,
        "closing_hour": hour,
        "promo": promo,
        "predicted_visits": {s: 50.0 * persona.weight for s in segments},
    }


def _proposal_prompt(persona: Persona, segments: list[str], question: str,
                     belief_block: str, review_lines: str) -> list[dict]:
    return [
        {"role": "system", "content":
            "You are a business-simulation agent. Respond with JSON only."},
        {"role": "user", "content": f"""Decision question: {question}
Decision space: price_change_pct in {PRICE_GRID}, closing_hour in {HOUR_GRID}
(26 = 2 AM, baseline close = 9 PM/21), promo in {PROMO_GRID}.

Business reviews you have seen:
{review_lines}

Shared belief notes from past rounds (you agreed to these as a crowd):
{belief_block}

You are persona "{persona.name}" (segment: {persona.segment}, weight
{persona.weight}). Argue from YOUR customers' perspective, then commit one
concrete decision and VISIT PREDICTIONS per segment for the NORMAL week.
Answer with JSON only:
{{"price_change_pct": <int>, "closing_hour": <int 21-26>,
  "promo": "<none|student_deal|game_day_special>",
  "predicted_visits": {{{", ".join(f'"{s}": <number>' for s in segments)}}}}}"""},
    ]


def _parse_proposal(raw: str | None, persona: Persona, segments: list[str],
                    beliefs: dict, salt: str) -> dict:
    data = _extract_json(raw) if raw else {}

    def _num(key, default):
        try:
            return int(round(float(data.get(key))))
        except (TypeError, ValueError):
            return default

    promo = data.get("promo")
    if promo not in PROMO_GRID:
        promo = "none"
    pv = {}
    for s in segments:
        try:
            pv[s] = max(0.0, float(data.get("predicted_visits", {}).get(s)))
        except (TypeError, ValueError):
            pv[s] = 0.0
    if not any(pv.values()):  # unusable prediction block -> offline heuristic
        return _heuristic_proposal(persona, segments, beliefs, salt)
    hour = _num("closing_hour", 21)
    return {
        "price_change_pct": max(PRICE_GRID[0], min(PRICE_GRID[-1], _num("price_change_pct", 0))),
        "closing_hour": max(min(HOUR_GRID), min(max(HOUR_GRID), hour)),
        "promo": promo,
        "predicted_visits": pv,
    }


async def _propose(personas: list[Persona], reviews: list[dict],
                   segments: list[str], question: str, beliefs: dict,
                   round_no: int, run_id: str) -> list[dict]:
    review_lines = "\n".join(
        f"[{(r.get('segment_hint') or 'reviewer')}] {(r.get('text') or '').strip()}"
        for r in reviews[:30] if (r.get("text") or "").strip())
    belief_block = "\n".join(
        f"- {seg}: {note.strip() or '(no belief yet)'}"
        for seg, note in beliefs.items())

    jobs = [_proposal_prompt(p, segments, question, belief_block, review_lines)
            for p in personas]
    raws = await _ask_many([{"messages": j, "temperature": 0.5,
                             "max_tokens": 400, "json_mode": True} for j in jobs])
    return [
        _parse_proposal(raw, persona, segments, beliefs, f"{run_id}|{round_no}")
        for raw, persona in zip(raws, personas)
    ]


def _aggregate(personas: list[Persona], proposals: list[dict],
               segments: list[str]) -> tuple[SimDecision, dict[str, float]]:
    """Weighted-mean numeric fields, weighted-majority promo."""
    weights = [max(0.01, p.weight) for p in personas]
    wsum = sum(weights)
    price = sum(w * pr["price_change_pct"] for w, pr in zip(weights, proposals)) / wsum
    hour = sum(w * pr["closing_hour"] for w, pr in zip(weights, proposals)) / wsum
    tally: dict[str, float] = {}
    for w, pr in zip(weights, proposals):
        tally[pr["promo"]] = tally.get(pr["promo"], 0.0) + w
    promo = max(tally, key=tally.get)

    pred: dict[str, float] = {}
    for seg in segments:
        vals = [(w, pr["predicted_visits"][seg])
                for w, pr in zip(weights, proposals) if seg in pr["predicted_visits"]]
        if vals:
            pred[seg] = round(sum(w * v for w, v in vals) / sum(w for w, _ in vals), 4)
    hour_i = max(min(HOUR_GRID), min(max(HOUR_GRID), int(round(hour))))
    return SimDecision(price_change_pct=round(price, 2),
                       closing_hour=hour_i, promo=promo), pred


# ------------------------------------------------------------------ reflection

async def _reflect(segments: list[str], beliefs: dict, reviews: list[dict],
                   decision: SimDecision, actual: dict[str, float],
                   predicted: dict[str, float]) -> dict:
    """One reflection call per segment (parallel); <=120-word belief notes."""
    review_by_hint: dict[str, list[str]] = {}
    for r in reviews:
        text = (r.get("text") or "").strip()
        hint = (r.get("segment_hint") or "").strip().lower()
        if not text:
            continue
        review_by_hint.setdefault(hint, []).append(text)

    async def one(seg: str) -> str:
        relevant: list[str] = [t for hint, ts in review_by_hint.items()
                               if seg.lower() in hint for t in ts]
        if not relevant:
            relevant = [t for ts in review_by_hint.values() for t in ts][:6]
        act, prd = actual.get(seg), predicted.get(seg)
        err_txt = (f"predicted {prd:.1f} vs actual {act:.1f} "
                   f"(error {abs((prd or 0) - act):.1f})") if prd is not None \
                  else f"actual {act}"
        jobs = [{"messages": [
            {"role": "system", "content":
                "You maintain belief notes for a market-simulation agent. JSON only."},
            {"role": "user", "content": f"""Segment: {seg}
Old belief note: {(beliefs.get(seg) or "(empty)").strip()}

Reviews relevant to this segment:
{chr(10).join('- ' + t for t in relevant[:10])}

Last decision: price {decision.price_change_pct:+.0f}%, closing_hour {decision.closing_hour},
promo {decision.promo}.
This segment's outcome: {err_txt}.

Rewrite the belief note for this segment in at most 120 words: what you now
believe about how this segment responds to price, hours, and promos, and what
to try next. Be concrete and numeric where possible. JSON: {{"note": "..."}}"""}],
            "temperature": 0.4, "max_tokens": 220, "json_mode": True}]
        raw = (await _ask_many(jobs))[0]
        if not raw:
            return beliefs.get(seg, "")  # no LLM -> keep old note
        note = str(_extract_json(raw).get("note", "")).strip()
        return _clip_words(note) if note else beliefs.get(seg, "")

    notes = await asyncio.gather(*(one(s) for s in segments))
    return dict(zip(segments, notes))


# ------------------------------------------------------------------ the loop

def _keep_gate(round_regret: float, best_regret: float | None) -> bool:
    """Keep a belief update only if mean train regret strictly dropped."""
    return best_regret is None or round_regret < best_regret


def _ctx_book(contexts_override: dict | None) -> tuple[list[str], dict]:
    """contexts_override (the dict derive_contexts returns) -> (train names,
    name -> context map). Empty/None -> the classic hardcoded behavior."""
    ov = contexts_override if isinstance(contexts_override, dict) else {}
    entries = [c for side in ("train", "test")
               for c in (ov.get(side) or []) if isinstance(c, dict)]
    ctx_map: dict[str, dict] = {}
    for c in entries:
        name = str(c.get("name") or "").strip()
        if name:
            ctx_map[name] = c
    train_names = [str(c.get("name")).strip()
                   for c in (ov.get("train") or [])
                   if isinstance(c, dict) and str(c.get("name") or "").strip()]
    return train_names, ctx_map


async def run_loop(
    business_class: str,
    personas: list[Persona],
    reviews: list[dict],
    question: str,
    truth: dict,
    rounds: int = 5,
    contexts_override: dict | None = None,
) -> list[RoundScore]:
    """rounds=5 -> round 0 baseline + rounds 1..N. Returns every RoundScore.

    contexts_override (derive_contexts' dict) switches the train scenarios:
    round 0 stays the normal-week baseline, rounds 1..N rotate through the
    derived train contexts. None (default) = the classic hardcoded behavior.
    """
    segments = [s for s in truth["segments"]]
    personas = list(personas) or [Persona(
        id="fallback", segment=segments[0], name="The House",
        profile="Generic walk-in customer", source_review_ids=[], weight=1.0)]
    run_id = uuid.uuid4().hex[:10]

    beliefs: dict[str, str] = {s: "" for s in segments}
    best_regret: float | None = None
    best_beliefs = beliefs
    rows: list[RoundScore] = []
    best_rev = grid_best("normal", truth)
    train_names, ctx_map = _ctx_book(contexts_override)

    proposals: list[dict] = []
    for r in range(rounds + 1):
        round_ctx = "normal" if (r == 0 or not train_names) \
            else train_names[(r - 1) % len(train_names)]
        round_best = best_rev if round_ctx == "normal" \
            else grid_best(round_ctx, truth, contexts=ctx_map)

        # --- parallel propose ---
        proposals = await _propose(personas, reviews, segments, question,
                                   beliefs, r, run_id)
        decision, predicted = _aggregate(personas, proposals, segments)

        # --- simulate + score ---
        outcome = simulate(decision, round_ctx, truth, deterministic=True,
                           contexts=ctx_map)
        regret = regret_of(decision, round_ctx, truth, best=round_best,
                           contexts=ctx_map)
        errs = [abs(predicted[s] - outcome.visits_by_segment[s])
                for s in segments if s in predicted]
        pred_err = sum(errs) / len(errs) if errs else 0.0
        rows.append(RoundScore(run_id=run_id, round=r, regret=round(regret, 6),
                               prediction_error=round(pred_err, 4), split="train"))

        if r == rounds:
            break

        # --- reflection -> candidate beliefs ---
        candidate = await _reflect(segments, beliefs, reviews, decision,
                                   outcome.visits_by_segment, predicted)

        # --- keep-only-improvements ---
        if _keep_gate(regret, best_regret):
            best_regret = regret
            best_beliefs = candidate
        beliefs = best_beliefs

    _RUN_STATE[run_id] = {
        "business_class": business_class,
        "final_decision": _aggregate(personas, proposals, segments)[0],
        "final_beliefs": dict(beliefs),
        "best_regret": best_regret,
    }
    return rows