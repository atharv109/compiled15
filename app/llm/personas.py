"""Persona builder: emergent segments from reviews -> ~50 personas in ~5 batched calls.

Returns (personas, segments_overview). segments_overview is [{name, count}] — the
snapshot endpoint's `segments` field. (Pinned signature said list[Persona]; returning
segments along with personas is required for the snapshot, so it's a tuple.)
"""
from __future__ import annotations
import json, re
from collections import Counter
from pydantic import ValidationError

from app.models import BusinessClass, EvidenceCard, Persona, PERSONA_FAMILY_HINTS
from app.llm import client

PERSONAS_TOTAL = 50
BATCH_CALLS = 5
PER_CALL = PERSONAS_TOTAL // BATCH_CALLS  # 10

_JSON_OBJ = re.compile(r"\{.*\}", re.S)
_JSON_ARR = re.compile(r"\[.*\]", re.S)


def _evidence_lines(evidence: list[EvidenceCard], cap: int = 40) -> str:
    return "\n".join(f"- {e.id}: {e.claim}" for e in evidence[:cap])


def _review_lines(reviews: list[dict], cap: int = 40) -> str:
    out = []
    for r in reviews[:cap]:
        text = str(r.get("text", ""))[:200]
        out.append(f"[{r.get('rating', '?')}] ({r.get('context', '')}) {text}")
    return "\n".join(out) or "(no reviews provided)"


def _system_prompt() -> str:
    return (
        "You are a market-research persona builder. You ONLY reply with a JSON object. "
        "No markdown, no commentary."
    )


def _batch_prompt(business_class: str, evidence: list[EvidenceCard],
                  reviews: list[dict], count: int) -> list[dict]:
    family = PERSONA_FAMILY_HINTS.get(business_class, "customers")
    return [
        {"role": "system", "content": _system_prompt()},
        {"role": "user", "content": f"""Build {count} distinct customer personas for this business. They must be diverse and grounded in the evidence below — never invented.

Business class: {business_class}
Persona family hints (use as inspiration, pick what the reviews support): {family}

EVIDENCE CARDS (cite ids like ev_x from these):
{_evidence_lines(evidence)}

REVIEWS:
{_review_lines(reviews)}

Rules:
- Group them into 3-7 EMERGENT segments you invent from the reviews (e.g. "students", "families").
- Use the same segment name for every persona in that segment. Do not use a segment named "other".
- Each persona: name (human handle like "Sam the junior"), profile (2-3 sentences in-character background), segment, source_review_ids (subset of the evidence ids above that this persona is built from; 1-3 ids; only ids that appear in the list — if no review is relevant to this persona, use an empty list).
- Give each a unique index number (0..{count - 1}) in "idx".

Reply ONLY with: {{"personas": [{{"idx": 0, "name": ..., "segment": ..., "profile": ..., "source_review_ids": ["..."]}}]}}"""},
    ]


def _extract_json(text: str):
    """Parse the LLM reply: prefer the whole-text parse, then the first {...} block
    (whole-object, not a nested array), then a top-level [...] array."""
    if not text:
        return None
    text = text.strip().strip("`")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    m = _JSON_OBJ.search(text)  # first { -> last }
    if m:
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            pass
    m = _JSON_ARR.search(text)
    if m:
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            pass
    return None


def _parse_batch(raw: str | None, evidence_ids: set[str], expected: int) -> list[dict]:
    data = _extract_json(raw or "")
    if isinstance(data, dict):
        data = data.get("personas")
    if not isinstance(data, list):
        return []
    items = [p for p in data if isinstance(p, dict) and p.get("segment") and p.get("profile")]
    return items[:expected]


async def build_personas(
    business_class: str | BusinessClass,
    evidence: list[EvidenceCard],
    reviews: list[dict],
) -> tuple[list[Persona], list[dict]]:
    """~5 parallel calls, ~10 personas each. Returns (personas, segments [{name, count}])."""
    if isinstance(business_class, BusinessClass):
        business_class = business_class.value

    jobs = [
        {"messages": _batch_prompt(business_class, evidence, reviews, PER_CALL),
         "temperature": 0.85, "max_tokens": 2600, "json_mode": True}
        for i in range(BATCH_CALLS)
    ]
    raws = await client.generate_many(jobs, concurrency=BATCH_CALLS)

    evidence_ids = {e.id for e in evidence}
    seen_segments = Counter()
    used_names: set[str] = set()
    personas: list[Persona] = []
    for i, raw in enumerate(raws):
        items = _parse_batch(raw, evidence_ids, PER_CALL)
        for item in items:
            seg = str(item.get("segment", "")).strip().lower()
            if not seg or seg in {"other", "misc", "unknown"}:
                seg = "customers"
            seen_segments[seg] += 1
            src_ids = [x for x in item.get("source_review_ids", []) if x in evidence_ids]
            name = str(item.get("name", "")).strip() or f"Persona {len(personas) + 1}"
            while name in used_names:
                name = f"{name} 2"
            used_names.add(name)
            try:
                personas.append(Persona(
                    id=f"p{len(personas) + 1}",
                    segment=seg,
                    name=name[:60],
                    profile=str(item.get("profile", "")).strip(),
                    source_review_ids=src_ids,
                    weight=1.0,
                ))
            except ValidationError:
                continue

    if not personas:
        raise RuntimeError("persona generation returned no usable personas (all lanes failed?)")

    # clamp to PERSONAS_TOTAL / weight = segment prevalence share
    personas = personas[:PERSONAS_TOTAL]
    total = len(personas)
    seg_counts = Counter(p.segment for p in personas)
    for p in personas:
        p.weight = round(seg_counts[p.segment] / total, 4)

    segments = [{"name": seg, "count": n} for seg, n in seg_counts.most_common()]
    return personas, segments