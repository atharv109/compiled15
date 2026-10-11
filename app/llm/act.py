"""Act tab (P-act): the swarm's advice becomes concrete artifacts the owner can use.

Flow: verdict + debate events -> artifact_type (cheap heuristic, no LLM) -> n
parallel crowd-lane drafts, each seeded with a DIFFERENT winning-camp argument
or segment-impact row -> ONE strong-lane temperature-0 judge scores them and
picks the winner. Deterministic fallbacks everywhere; the only raise is the
pre-flight "run debate first" guard (routing/gating stays in main.py).

Event/backlog note: stances/camps live as SSE events in bus.backlog as
(event_type, json_string) tuples; _unwrap_events (shared with chat.py)
normalizes both backlog tuples and event dicts.

LLM access ONLY via app.llm.client.generate/generate_many. Zero network in
tests: caller monkeypatches client.generate/_many (see tests/test_act.py).
"""
from __future__ import annotations

import logging

from app.models import BusinessClass
from app.llm import client
from app.llm.personas import _extract_json
from app.llm.chat import _get, _normalize_evidence, _unwrap_events

log = logging.getLogger("llm.act")

SUPPORT = "support"
OPPOSE = "oppose"

DRAFT_MAX_TOKENS = 700
JUDGE_MAX_TOKENS = 900

ACT_TYPES = {"promo_copy", "signage_flyer", "menu_item_copy",
             "landing_page_snippet", "schedule_policy"}

_ARTIFACT_HINTS = {
    "promo_copy": "a short promotional copy blast (social post / text-message style)",
    "signage_flyer": "signage or flyer copy (headline plus supporting lines, offer and details)",
    "menu_item_copy": "menu item copy (item name, one-line description, price positioning)",
    "landing_page_snippet": "landing page snippet (hero headline, subhead, one call to action)",
    "schedule_policy": "a schedule/policy change note (what changes, who it applies to, effective when)",
}


def artifact_type_for(business_class: str, question: str) -> str:
    """Cheap, deterministic heuristic — no LLM. local_consumer questions split
    promo/flyer/menu by keywords; startup -> landing page; everything else
    (b2b_service, regulated, unknown/empty) -> schedule_policy.
    """
    bc = str(getattr(business_class, "value", business_class) or "").strip().lower()
    q = str(question or "").strip().lower()
    if bc == BusinessClass.startup.value:
        return "landing_page_snippet"
    if bc == "local_consumer":
        if any(k in q for k in ("menu", "dish", "price", "pricing", "item", "vegetarian")):
            return "menu_item_copy"
        if any(k in q for k in ("flyer", "sign", "poster", "banner", "opening", "print")):
            return "signage_flyer"
        return "promo_copy"
    return "schedule_policy"  # b2b_service, regulated, unknown


# ------------------------------------------------- winning camp + seed pool


def _majority_stance(verdict, events: list) -> str:
    """The side that won the vote ('support' | 'oppose'), from the verdict tally;
    when the tally is missing or even, the latest-round stance events decide.
    Everything else falls back to 'support'."""
    tally = _get(verdict, "tally", {}) or {}
    try:
        s = int(float(tally.get("support") or 0))
        o = int(float(tally.get("oppose") or 0))
    except (TypeError, ValueError):
        s = o = 0
    if s == o:
        stances = [e for e in _unwrap_events(events) if e.get("type") == "stance"]
        if stances:
            top = max(int(e.get("round", 0) or 0) for e in stances)
            latest = [e for e in stances if int(e.get("round", 0) or 0) == top]
            s = sum(1 for e in latest if e.get("stance") == SUPPORT)
            o = sum(1 for e in latest if e.get("stance") == OPPOSE)
    return OPPOSE if o > s else SUPPORT


_SIDE_WORDS = {
    OPPOSE: ("skeptic", "oppose", "concern", "against"),
    SUPPORT: ("support", "loyal", "backer"),
}


def _winning_camp(winner: str, events: list) -> dict | None:
    """The latest-round camp event describing the majority side. Resolved by
    member overlap with the winning-stance personas, then by camp-name keywords,
    then by size. None if no camp events exist."""
    camps = [e for e in _unwrap_events(events) if e.get("type") == "camp"]
    if not camps:
        return None
    top = max(int(e.get("round", 0) or 0) for e in camps)
    cands = [e for e in camps if int(e.get("round", 0) or 0) == top]
    if len(cands) == 1:
        return cands[0]
    win_ids = {str(e.get("persona_id", "")) for e in _unwrap_events(events)
               if e.get("type") == "stance" and e.get("stance") == winner}
    name_low = str(winner)
    def score(e: dict) -> tuple[int, int, int]:
        overlap = len({str(m) for m in (e.get("member_ids") or [])} & win_ids)
        word = 1 if any(w in str(e.get("camp", "")).lower() for w in _SIDE_WORDS[name_low]) else 0
        return (overlap, word, len(e.get("member_ids") or []))
    return max(cands, key=score)


def _winning_reasons(winner: str, events: list) -> list[str]:
    """Latest-round in-character reasons of the winning side (seed filler)."""
    stances = [e for e in _unwrap_events(events)
               if e.get("type") == "stance" and e.get("stance") == winner]
    if not stances:
        return []
    top = max(int(e.get("round", 0) or 0) for e in stances)
    return [str(e.get("reason", "")).strip() for e in stances
            if int(e.get("round", 0) or 0) == top and str(e.get("reason", "")).strip()]


def _seed_pool(winner: str, camp_ev: dict | None, verdict, events: list, n: int) -> list[str]:
    """n-or-more distinct draft seeds: winning-camp arguments, then segment-impact
    rows; objections and winning voters only pad if the pool runs short."""
    seeds: list[str] = []
    seen: set[str] = set()

    def add(label: str, text: str) -> None:
        text = str(text).strip()
        if text and text not in seen:
            seen.add(text)
            seeds.append(f"{label}: {text}")

    if camp_ev:
        for a in (camp_ev.get("top_arguments") or []):
            add("winning-camp argument", a)
    for si in (_get(verdict, "segment_impact", []) or []):
        seg = str(_get(si, "segment", "")).strip()
        imp = str(_get(si, "impact", "")).strip()
        add(f"segment impact ({seg or 'unnamed'})", imp)
    if len(seeds) < n:
        for o in (_get(verdict, "objections", []) or []):
            if len(seeds) < n:
                add("objection to address head-on", o)
    if len(seeds) < n:
        for r in _winning_reasons(winner, events):
            if len(seeds) < n:
                add("winning-voter voice", r)
    if not seeds:
        add("the verdict recommendation", _get(verdict, "recommendation", ""))
    return seeds


# ------------------------------------------------- prompts


def _verdict_summary(verdict) -> str:
    rec = str(_get(verdict, "recommendation", "")).strip() or "(none)"
    objections = [str(o).strip() for o in (_get(verdict, "objections", []) or []) if str(o).strip()]
    return f"recommendation: {rec} | top objections: {'; '.join(objections) or '(none)'}"


def _draft_prompt(question: str, verdict_summary: str, artifact_type: str,
                  seed: str, ev_lines: str) -> list[dict]:
    return [
        {"role": "system", "content": "You write ready-to-use artifacts for a small-business owner. Reply ONLY with a JSON object, no markdown."},
        {"role": "user", "content": f"""DRAFT ARTIFACT

THE DECISION: {question}
VERDICT SUMMARY (stay consistent with it unless the evidence contradicts it): {verdict_summary}
ARTIFACT KIND: {artifact_type} — {_ARTIFACT_HINTS[artifact_type]}

SEED FOCUS: build THIS draft around exactly this angle. Other drafts cover the other angles — do not blend them.
{seed}

EVIDENCE (cite id(s) that actually support the copy; NEVER invent an id; [] if none fit):
{ev_lines}

Rules:
- title: <=8 words.
- body_text: the artifact itself, <=160 words, ready to print/paste.
- rationale: 1-2 sentences — which debate argument/segment this leans on.
- evidence_ids: subset of the ids above; empty list allowed.

Reply ONLY with: {{"title": "...", "body_text": "...", "rationale": "...", "evidence_ids": ["..."]}}"""},
    ]


def _judge_prompt(question: str, verdict_summary: str,
                  draft_lines: str, ev_lines: str) -> list[dict]:
    return [
        {"role": "system", "content": "You are an even-handed judge of candidate business artifacts. Reply ONLY with a JSON object."},
        {"role": "user", "content": f"""SCORE EACH DRAFT

THE DECISION: {question}
VERDICT SUMMARY: {verdict_summary}
DRAFTS:
{draft_lines}
EVIDENCE (id: claim):
{ev_lines}

Score each draft 0.0..1.0 on how well it matches the verdict, stays grounded in the evidence, and is ready to use as-is. Deduct for claims no evidence supports. Pick the single best draft.

Reply ONLY with: {{"scores": [{{"id": "...", "score": 0.0, "why": "<=15 words"}}], "best_id": "..."}}"""},
    ]


# ------------------------------------------------- drafting


async def draft_artifacts(question, verdict, camp_events, evidence,
                          business_class, n: int = 3) -> list[dict]:
    """n parallel crowd-lane drafts (json_mode, ~700 tokens each). Each draft is
    {id, title, body_text, rationale, evidence_ids}; seeded with a DIFFERENT
    winning-camp argument or segment-impact row. Fabricated evidence ids are
    filtered to real ids (empty list allowed)."""
    by_id, ev_lines = _normalize_evidence(evidence)
    winner = _majority_stance(verdict, camp_events)
    camp_ev = _winning_camp(winner, camp_events)
    seeds = _seed_pool(winner, camp_ev, verdict, camp_events, n)
    verdict_summary = _verdict_summary(verdict)
    artifact_type = artifact_type_for(business_class, question)

    jobs = [{"messages": _draft_prompt(question, verdict_summary, artifact_type,
                                       seeds[i % len(seeds)], ev_lines),
             "temperature": 0.85, "max_tokens": DRAFT_MAX_TOKENS, "json_mode": True}
            for i in range(n)]
    raws = await client.generate_many(jobs, concurrency=min(n, 8), prefer="crowd")
    return [_build_draft(f"d{i + 1}", raw, seeds[i % len(seeds)], artifact_type,
                         set(by_id))
            for i, raw in enumerate(raws)]


def _build_draft(draft_id: str, raw: str | None, seed: str, artifact_type: str,
                 evidence_ids: set[str]) -> dict:
    data = _extract_json(raw or "")
    usable = isinstance(data, dict) and (str(data.get("body_text", "")).strip()
                                         or str(data.get("title", "")).strip())
    if not usable:
        return {
            "id": draft_id,
            "title": f"{artifact_type} — option {draft_id}",
            "body_text": f"(drafting lane unavailable; start from: {seed})",
            "rationale": "Deterministic fallback: the drafting lane did not reply for this seed.",
            "evidence_ids": [],
        }
    ev = [str(x) for x in (data.get("evidence_ids") or []) if str(x) in evidence_ids]
    return {
        "id": draft_id,
        "title": str(data.get("title", "")).strip()[:90] or f"{artifact_type} — option {draft_id}",
        "body_text": str(data.get("body_text", "")).strip(),
        "rationale": str(data.get("rationale", "")).strip()[:400],
        "evidence_ids": ev,
    }


# ------------------------------------------------- judging


def _clean_scores(data, draft_ids: set[str]) -> list[dict]:
    """['scores'] entries -> [{id, score, why}] with numeric clamped scores and
    known ids only. Non-numeric scores and unknown ids are dropped."""
    out: list[dict] = []
    for s in (data.get("scores") or []) if isinstance(data, dict) else []:
        if not isinstance(s, dict):
            continue
        sid = str(s.get("id", "")).strip()
        if sid not in draft_ids:
            continue
        try:
            score = max(0.0, min(1.0, float(s.get("score"))))
        except (TypeError, ValueError):
            continue
        out.append({"id": sid, "score": round(score, 3),
                    "why": str(s.get("why", "")).strip()[:120]})
    return out


def _fallback_scores(drafts: list[dict], evidence_by_id: dict) -> list[dict]:
    """Deterministic tiebreaker when the judge lane fails: score each draft by
    the COUNT of real evidence ids its rationale mentions (best = 1.0)."""
    counts = {d["id"]: sum(1 for eid in sorted(evidence_by_id)
                           if eid in str(d.get("rationale", ""))) for d in drafts}
    top = max(counts.values(), default=0)
    return [{"id": d["id"],
             "score": round(counts[d["id"]] / top, 3) if top else 0.5,
             "why": (f"fallback: {counts[d['id']]} evidence ids cited in rationale"
                     if top else "fallback: judge lane down; no citations")}
            for d in drafts]


def _pick_best(valid_scores: list[dict], llm_best: str, drafts: list[dict]) -> str:
    """LLM best_id if it is a real draft with a real score, else argmax score
    (ties -> earliest draft), else the first draft. Never returns a wrong id."""
    order = [d["id"] for d in drafts]
    scored = {s["id"] for s in valid_scores}
    if llm_best in order and (not scored or llm_best in scored):
        return llm_best
    if valid_scores:
        return max(valid_scores, key=lambda s: (s["score"], -order.index(s["id"])))["id"]
    return order[0]


async def judge_artifacts(question, drafts: list[dict], evidence, verdict,
                          artifact_type: str | None = None) -> dict:
    """ONE strong-lane temperature-0 call scores drafts {id, score 0-1, why}
    against the evidence + verdict and picks best_id. Falls back deterministically
    (evidence-id counts in rationales) when the lane fails — never raises.
    artifact_type is passed by run_act; standalone callers get the same cheap
    heuristic with the business class unknown."""
    if not drafts:
        return {"drafts": [], "scores": [], "best_id": "", "artifact_type":
                artifact_type or artifact_type_for("", question),
                "fallback_used": False}
    by_id, ev_lines = _normalize_evidence(evidence)
    draft_lines = "\n".join(
        f"- {d['id']} ({d.get('title', '')}): {str(d.get('body_text', ''))[:400]} "
        f"| rationale: {d.get('rationale', '')} | evidence_ids: {d.get('evidence_ids', [])}"
        for d in drafts)
    raw = await client.generate(
        _judge_prompt(question, _verdict_summary(verdict), draft_lines, ev_lines),
        temperature=0, max_tokens=JUDGE_MAX_TOKENS, json_mode=True, prefer="strong")

    data = _extract_json(raw or "")
    draft_ids = {d["id"] for d in drafts}
    scores = _clean_scores(data, draft_ids)
    llm_best = str((data or {}).get("best_id", "")).strip() if isinstance(data, dict) else ""
    fallback_used = not scores
    if fallback_used:
        scores = _fallback_scores(drafts, by_id)
        log.info("judge_artifacts: strong lane failed; deterministic fallback used")
    best_id = _pick_best(scores, llm_best, drafts)

    return {
        "drafts": drafts,
        "scores": scores,
        "best_id": best_id,
        "artifact_type": artifact_type or artifact_type_for("", question),
        "fallback_used": fallback_used,
    }


# ------------------------------------------------- entrypoint


async def run_act(question, verdict, debate_events, evidence, business_class,
                  on_event=None) -> dict:
    """The POST /api/sessions/{id}/act body. question/verdict/evidence come from
    the session doc; debate_events are stance+camp dicts or bus backlog
    (event_type, json_string) tuples. on_event is the awaited bus push — call it
    AFTER routing/gating (payment etc.) in main.py. Raises ValueError('run
    debate first') when no verdict has been computed yet."""
    if not verdict:
        raise ValueError("run debate first")

    events = list(debate_events or [])

    async def emit(detail: str, **extra) -> None:
        if on_event is None:
            return
        try:
            await on_event({"type": "act", "stage_detail": detail, **extra})
        except Exception as e:  # noqa: BLE001
            log.warning("on_event callback failed: %s", e)

    artifact_type = artifact_type_for(business_class, question)
    await emit(f"drafting 3 {artifact_type} artifacts from the winning camp")

    drafts = await draft_artifacts(question, verdict, events, evidence,
                                   business_class, n=3)
    await emit(f"judging {len(drafts)} drafts (strong lane)")

    result = await judge_artifacts(question, drafts, evidence, verdict,
                                   artifact_type=artifact_type)
    await emit(f"act done: best artifact {result['best_id']}", best_id=result["best_id"])
    return result