"""Aggregation-first judge: computes the tally/camp/segment breakdown itself, then
one temperature-0 LLM call writes the recommendation/objections/segment impact.
Confidence is the computed normalized tally skew, NOT a judge self-report — a
near-even tally legitimately yields low confidence, and that is a feature.
Verdicts are cached in-session by (business, question_text).
"""
from __future__ import annotations
import hashlib, json, re
from collections import Counter
from pydantic import ValidationError

from app.models import Camp, EvidenceCard, Persona, SegmentImpact, Stance, Verdict
from app.llm import client
from app.llm.personas import _extract_json

_verdict_cache: dict[str, Verdict] = {}

_CONFERENCE_THRESHOLD_NEAR_EVEN = 0.35  # skew below this = "feature: low confidence"


def verdict_cache_key(business, question_text: str) -> str:
    h = hashlib.sha1()
    h.update(_business_key(business).encode("utf-8", "ignore"))
    h.update(b"\x00")
    h.update(" ".join(question_text.split()).strip().lower().encode("utf-8", "ignore"))
    return h.hexdigest()


def _business_key(business) -> str:
    if isinstance(business, dict):
        parts = [business.get("business_id") or business.get("id") or
                 f"{business.get('name', '')}|{business.get('town', '')}"]
        return str(parts[0])
    if hasattr(business, "business_id"):
        return str(business.business_id)
    if hasattr(business, "name"):
        return str(business.name)
    return str(business)


def compute_confidence(stances: list[Stance], camps: list[Camp]) -> float:
    """Normalized tally skew: |support - oppose| / (support + oppose) of decisive
    (non-neutral) stances. 0.0 = 50/50 split, 1.0 = unanimous. Neutrals dilute
    opinion strength slightly."""
    s = sum(1 for x in stances if x.stance == "support")
    o = sum(1 for x in stances if x.stance == "oppose")
    n = sum(1 for x in stances if x.stance == "neutral")
    decisive = s + o
    if decisive == 0:
        return 0.15  # all-neutral: extremely soft signal
    skew = abs(s - o) / decisive
    decisive_share = decisive / max(1, len(stances))
    return round(min(1.0, skew * (0.75 + 0.25 * decisive_share)), 3)


def _latest(round_no: int, items):
    by_round = {}
    for x in items:
        by_round.setdefault(getattr(x, "round", 0), []).append(x)
    return by_round.get(max(by_round), []) if by_round else []


def _segment_breakdown(personas: list[Persona], stances: list[Stance]) -> list[dict]:
    seg_of = {p.id: p.segment for p in personas}
    out = []
    for seg in sorted({p.segment for p in personas}):
        members = [s for s in stances if seg_of.get(s.persona_id) == seg]
        if not members:
            continue
        c = Counter(s.stance for s in members)
        out.append({"segment": seg, "support": c.get("support", 0),
                    "oppose": c.get("oppose", 0), "neutral": c.get("neutral", 0)})
    return out


async def judge(
    question: str,
    business,
    evidence: list[EvidenceCard],
    personas: list[Persona],
    stances: list[Stance],
    camps: list[Camp],
) -> Verdict:
    """Returns the (cached) Verdict. Aggregation first — LLM only writes prose."""
    key = verdict_cache_key(business, question)
    cached = _verdict_cache.get(key)
    if cached is not None:
        return cached

    # final-round stances + camps
    final_stances = _latest(max((s.round for s in stances), default=1), stances)
    if not final_stances:
        final_stances = stances
    final_camps = _latest(max((c.round for c in camps), default=1), camps) or camps

    tally = {"support": sum(1 for s in final_stances if s.stance == "support"),
             "oppose": sum(1 for s in final_stances if s.stance == "oppose"),
             "neutral": sum(1 for s in final_stances if s.stance == "neutral")}
    confidence = compute_confidence(final_stances, final_camps)
    breakdown = _segment_breakdown(personas, final_stances)
    camp_block = "\n".join(
        f"{c.name} ({len(c.member_ids)} members): " + "; ".join(c.top_arguments[:3])
        for c in final_camps) or "(no camps)"

    evidence_by_id = {e.id: e for e in evidence}
    ev_lines = "\n".join(f"{e.id}: {e.claim}" for e in evidence[:30])

    fallback_segments = fallback_impact(final_stances, personas, evidence_by_id)

    raw = await client.generate(
        [
            {"role": "system", "content": "You are an even-handed decision judge for a small-business owner. You follow the structured tally above your own gut. Reply ONLY with a JSON object."},
            {"role": "user", "content": f"""QUESTION: {question}

STRUCTURED TALLY of {len(final_stances)} customer agents: support={tally['support']}, oppose={tally['oppose']}, neutral={tally['neutral']}
Normalized confidence (computed): {confidence}
SEGMENT BREAKDOWN: {json.dumps(breakdown, ensure_ascii=False)}
CAMPS + TOP ARGUMENTS:
{camp_block}
EVIDENCE CARDS:
{ev_lines}

Write, for the owner:
- recommendation: 2-4 sentences, decision-first ("Do X, because..."), grounded ONLY in the tally, arguments and evidence above.
- objections: top 3 objections to your recommendation, strongest first (the opposing camp's best material).
- segment_impact: for the 2-4 most affected segments, impact = one concrete expected effect on that segment; evidence_ids MUST be ids from the evidence list that support it. Do NOT invent ids; use [] if unsure.
- confidence_note is not needed; confidence is computed for you.

Reply ONLY with: {{"recommendation": "...", "objections": ["...", "...", "..."], "segment_impact": [{{"segment": "...", "impact": "...", "evidence_ids": ["..."]}}]}}"""},
        ],
        temperature=0, max_tokens=800, json_mode=True, prefer="strong",
    )

    verdict = _assemble_verdict(raw, tally, confidence, fallback_segments, evidence_by_id)
    _verdict_cache[key] = verdict
    return verdict


def fallback_impact(final_stances: list[Stance], personas: list[Persona],
                    evidence_by_id: dict[str, EvidenceCard]) -> list[SegmentImpact]:
    seg_of = {p.id: p.segment for p in personas}
    by_seg: dict[str, list[Stance]] = {}
    for s in final_stances:
        by_seg.setdefault(seg_of.get(s.persona_id, "?"), []).append(s)
    impacts = []
    for seg, members in sorted(by_seg.items()):
        c = Counter(s.stance for s in members)
        n = max(1, len(members))
        parts = []
        if c.get("support"):
            parts.append(f"{c['support']}/{n} support")
        if c.get("oppose"):
            parts.append(f"{c['oppose']}/{n} oppose")
        if not parts:
            parts.append("no strong reaction")
        ev = sorted({e for s in members for e in s.evidence_ids if e in evidence_by_id})
        impacts.append(SegmentImpact(segment=seg, impact=", ".join(parts), evidence_ids=ev[:4]))
    return impacts


def _assemble_verdict(raw: str | None, tally: dict, confidence: float,
                      fallback_segments: list[SegmentImpact],
                      evidence_by_id: dict[str, EvidenceCard]) -> Verdict:
    data = _extract_json(raw or "") or {}
    recommendation = str(data.get("recommendation", "")).strip()
    if not recommendation:
        s, o = tally["support"], tally["oppose"]
        if s + o == 0:
            recommendation = "Customers are undecided on this question; it is not a live issue — gather more feedback before changing anything."
        elif s >= o:
            recommendation = f"Proceed: {s} customer agents support it vs {o} opposed, and no stronger counter-arguments emerged than those above."
        else:
            recommendation = f"Hold off: {o} customer agents oppose vs {s} in support — the objections above have the stronger evidence."

    objections = [str(x) for x in (data.get("objections") or []) if str(x).strip()][:3]
    if len(objections) < 3:
        filler = [f"Segment '{si.segment}' shows resistance: {si.impact}"
                  for si in fallback_segments if si.impact][:3 - len(objections)]
        objections += filler
        objections = objections[:3]

    impacts: list[SegmentImpact] = []
    seg_names = {si.segment for si in fallback_segments}
    for item in (data.get("segment_impact") or []):
        if not isinstance(item, dict):
            continue
        seg = str(item.get("segment", "")).strip()
        if seg not in seg_names:
            continue
        ev_ids = [x for x in (item.get("evidence_ids") or []) if x in evidence_by_id]
        try:
            impacts.append(SegmentImpact(segment=seg, impact=str(item.get("impact", "")).strip()[:300],
                                         evidence_ids=ev_ids[:4]))
        except ValidationError:
            continue
    if not impacts:
        impacts = fallback_segments
    return Verdict(recommendation=recommendation, confidence=confidence,
                   tally=tally, objections=objections, segment_impact=impacts)