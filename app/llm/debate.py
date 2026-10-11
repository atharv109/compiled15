"""Debate engine: round 1 independent votes -> auto-clustered camps -> digests ->
round 2 votes with digests. Emits contract events (stance / camp) as an async
generator; also ships collect_debate() for callers that want the final objects.
"""
from __future__ import annotations
import json
from collections import defaultdict
from typing import AsyncIterator

from app.config import cfg
from app.models import Camp, EvidenceCard, Persona, Stance
from app.llm import client
from app.llm.personas import _extract_json

EVIDENCE_PROMPT_CAP = 30

_STANCEWords = {"support": "supporters", "oppose": "skeptics", "neutral": "undecided"}


def _evidence_lines(evidence: list[EvidenceCard]) -> str:
    return "\n".join(f"{e.id}: {e.claim}" for e in evidence[:EVIDENCE_PROMPT_CAP])


def _stance_prompt(persona: Persona, question: str, evidence: list[EvidenceCard],
                   round_no: int, own_digest: str = "", opposing_digest: str = "") -> list[dict]:
    r2 = round_no >= 2
    reply_schema = (
        '{"stance": "...", "stance_label": "short human text", "reason": "...", "evidence_ids": ["..."], "predicted_visits": {"segment": 0.0..2.0}}'
        if r2 else
        '{"stance": "...", "stance_label": "short human text", "reason": "...", "evidence_ids": ["..."]}'
    )
    digest_block = ""
    if r2:
        digest_block = f"""
ROUND 2 — both camps have made their case. Here are the digests.

Your camp's strongest arguments:
{own_digest or '(none listed)'}

The opposing camp's strongest arguments:
{opposing_digest or '(none listed)'}
"""
    return [
        {"role": "system", "content": "You stay perfectly in character as the assigned customer persona. Reply ONLY with a single JSON object, no markdown."},
        {"role": "user", "content": f"""persona_id: {persona.id}
You are {persona.name}, segment "{persona.segment}". Profile: {persona.profile}

QUESTION the business owner is considering: {question}

EVIDENCE (one-line claims; cite id(s) that actually support your view):
{_evidence_lines(evidence)}
{digest_block}
Rules:
- Decide as this persona, using your profile and what customers like you said in the evidence.
- stance must be "support", "oppose", or "neutral".
- You MUST cite evidence_ids from the list above. If nothing is relevant to you, stance "neutral" with empty evidence_ids is the correct honest answer. NEVER invent an evidence id.
- reason: at most 2 sentences, in-character.
{"Also give predicted_visits: how your visit frequency would change if the owner did what you voted (multiplier per segment, 1.0 = unchanged, e.g. 0.6 = 40% fewer visits) as an object keyed by segment." if r2 else "No extra fields."}

Reply ONLY with: {reply_schema}""" },
    ]


def cluster_camps(stances: list[Stance], round_no: int) -> list[Camp]:
    """Deterministic round-N camps: segment x stance clusters (non-neutral), merged smalls."""
    groups: dict[tuple[str, str], list[Stance]] = defaultdict(list)
    neutral: list[Stance] = []
    for s in stances:
        if s.stance == "neutral":
            neutral.append(s)
            continue
        groups[(s.stance, s.segment)].append(s)

    if not groups and neutral:
        return [Camp(round=round_no, name="Undecided", member_ids=[s.persona_id for s in neutral],
                     top_arguments=[])]

    camps: list[tuple[str, str, list[Stance]]] = []
    for (stance, segment), members in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        camps.append((stance, segment, members))
    if len(camps) > 4:
        big = camps[0]
        merged: dict[str, list[Stance]] = defaultdict(list)
        for stance, _seg, members in camps[1:]:
            merged[stance].extend(members)
        camps = [big] + [(st, "", ms) for st, ms in sorted(merged.items(), key=lambda kv: -len(kv[1]))]

    result: list[Camp] = []
    for stance, segment, members in camps:
        label = _STANCEWords.get(stance, stance)
        name = f"{segment.title()} {label}" if segment else label.title()
        if stance == "oppose":
            question_word = "skeptics"
            name = f"{segment.title()} {question_word}" if segment else question_word.title()
        result.append(Camp(round=round_no, name=name,
                           member_ids=[s.persona_id for s in members], top_arguments=[]))
    for members in [neutral]:
        if members:
            result.append(Camp(round=round_no, name="Undecided",
                               member_ids=[s.persona_id for s in members], top_arguments=[]))
    return result


def _camp_key(stance: str, segment: str) -> str:
    return f"{stance}:{segment}"


async def _name_and_digest(camps: list[Camp], stances: list[Stance],
                           question: str) -> dict[str, dict]:
    """One call per camp: catchy name + 1-paragraph digest + 2-3 top arguments."""
    jobs, keys = [], []
    for c in camps:
        members = [s for s in stances if s.persona_id in set(c.member_ids)]
        args = [s.reason for s in members if s.stance != "neutral"][:8]
        if not members:
            continue
        keys.append((c, members))
        jobs.append({
            "messages": [
                {"role": "system", "content": "You summarize customer camps for a business owner. Reply ONLY with a JSON object."},
                {"role": "user", "content": f"""Question under debate: {question}
Camp members' stances and one-line reasons:
{json.dumps([{"stance": s.stance, "reason": s.reason} for s in members], ensure_ascii=False)}

Produce for this camp:
- name: a punchy label for the group (like "Open-late skeptics"), <=5 words
- top_arguments: the 2-3 strongest arguments in this camp, restated crisply (they can draw on the reasons above)
- digest: ONE paragraph (<=120 words) presenting those arguments from this camp's side.

Reply ONLY with: {{"name": "...", "top_arguments": ["..."], "digest": "..."}}"""},
            ],
            "temperature": 0.5, "max_tokens": 450, "json_mode": True,
        })
    if not jobs:
        return {}
    raws = await client.generate_many(jobs, concurrency=len(jobs))
    out: dict[str, dict] = {}
    for (camp, _members), raw in zip(keys, raws):
        data = _extract_json(raw or "")
        if isinstance(data, dict):
            out[_camp_key_from_camp(camp, stances)] = {
                "name": str(data.get("name", "")).strip()[:60],
                "top_arguments": [str(a) for a in (data.get("top_arguments") or [])[:3] if str(a).strip()],
                "digest": str(data.get("digest", "")).strip(),
            }
    return out


def _camp_key_from_camp(camp: Camp, stances: list[Stance]) -> str:
    by_id = {s.persona_id: s for s in stances}
    for pid in camp.member_ids:
        s = by_id.get(pid)
        if s and s.stance != "neutral":
            return _camp_key(s.stance, s.segment)
    return "neutral"


def _fallback_digest(camp: Camp, stances: list[Stance], enriched: dict) -> dict:
    data = enriched.get(_camp_key_from_camp(camp, stances), {})
    members = [s for s in stances if s.persona_id in set(camp.member_ids)]
    args = [s.reason for s in members if s.reason][:3]
    return {
        "name": data.get("name") or camp.name,
        "top_arguments": data.get("top_arguments") or args,
        "digest": data.get("digest") or ". ".join(args)[:600],
    }


async def run_debate(
    session_id: str,
    question: str,
    business_class,
    evidence: list[EvidenceCard],
    personas: list[Persona],
) -> AsyncIterator[dict]:
    """Async generator of contract events: stance (round 1..N), camp (per round end)."""
    by_id = {p.id: p for p in personas}
    prev_round_stances: list[Stance] = []
    enriched_names: dict[str, dict] = {}

    for round_no in range(1, max(1, cfg.DEBATE_ROUNDS) + 1):
        is_r2 = round_no >= 2
        if is_r2 and prev_round_stances:
            # camps from the previous round -> names + digests (one LLM call per camp)
            enriched_names = await _name_and_digest(
                cluster_camps(prev_round_stances, round_no - 1), prev_round_stances, question)

        # build jobs
        jobs = []
        digests: dict[str, dict] = {}
        if is_r2:
            prev_camps = cluster_camps(prev_round_stances, round_no - 1)
            camp_of = {}
            for c in prev_camps:
                for pid in c.member_ids:
                    camp_of[pid] = c
            for c in prev_camps:
                d = _fallback_digest(c, prev_round_stances, enriched_names)
                digests[c.name] = d
            others = {}
            for c2 in prev_camps:
                opposing = [
                    f"{digests[c3.name]['name']}: {digests[c3.name]['digest']}"
                    for c3 in prev_camps if c3.name != c2.name and digests.get(c3.name)
                ]
                others[c2.name] = "\n".join(opposing)

        for p in personas:
            own_digest = opposing_digest = ""
            if is_r2 and p.id in camp_of:
                c = camp_of[p.id]
                d = digests.get(c.name, {"name": c.name, "digest": "", "top_arguments": []})
                own_digest = d["digest"] or d["name"]
                opposing_digest = others.get(c.name, "")
            jobs.append({"messages": _stance_prompt(p, question, evidence, round_no,
                                                    own_digest=own_digest, opposing_digest=opposing_digest),
                         "temperature": 0.7, "max_tokens": 400 if is_r2 else 300,
                         "json_mode": True, "_persona_id": p.id})

        raws = await client.generate_many(
            [{k: v for k, v in j.items() if k != "_persona_id"} for j in jobs],
            concurrency=cfg.CONCURRENCY,
        )

        evidence_ids = {e.id for e in evidence}
        prev_round_stances = []
        for job, raw in zip(jobs, raws):
            persona = by_id[job["_persona_id"]]
            st = _build_stance(persona, raw, round_no, evidence_ids)
            prev_round_stances.append(st)
            yield {
                "type": "stance", "round": round_no, "persona_id": st.persona_id,
                "segment": st.segment, "stance": st.stance,
                "stance_label": st.stance_label, "reason": st.reason,
                "evidence_ids": st.evidence_ids,
                **({"predicted_visits": st.predicted_visits} if st.predicted_visits else {}),
            }

        # recluster camps for THIS round, emit camp event (enriched with LLM names if r2)
        camps = cluster_camps(prev_round_stances, round_no)
        for c in camps:
            d = _fallback_digest(c, prev_round_stances, enriched_names)
            c.name = d["name"] or c.name
            c.top_arguments = d["top_arguments"]
            yield {"type": "camp", "round": round_no, "camp": c.name,
                   "member_ids": c.member_ids, "top_arguments": c.top_arguments}


def _build_stance(persona: Persona, raw: str | None, round_no: int,
                  evidence_ids: set[str]) -> Stance:
    data = _extract_json(raw or "") or {}
    stance_raw = str(data.get("stance", "")).lower().strip()
    stance = stance_raw if stance_raw in {"support", "oppose", "neutral"} else "neutral"
    if stance == "neutral":
        ev: list[str] = []
    else:
        kept = [x for x in (data.get("evidence_ids") or []) if x in evidence_ids]
        ev = kept
        if not ev:  # a stance with no supportable evidence falls back to neutral
            stance = "neutral"
    return Stance(
        round=round_no,
        persona_id=persona.id,
        segment=persona.segment,
        stance=stance,
        stance_label=str(data.get("stance_label", "")).strip()[:40] or stance.title(),
        reason=str(data.get("reason", "")).strip()[:400] or "No strong feeling either way.",
        evidence_ids=ev,
        predicted_visits=_clean_visits(data.get("predicted_visits")) if round_no >= 2 else None,
    )


def _clean_visits(raw) -> dict[str, float] | None:
    if not isinstance(raw, dict) or not raw:
        return None
    out = {}
    for k, v in list(raw.items())[:8]:
        try:
            out[str(k)[:40]] = max(-1.0, min(3.0, float(v)))
        except (TypeError, ValueError):
            continue
    return out or None


async def collect_debate(
    session_id: str,
    question: str,
    business_class,
    evidence: list[EvidenceCard],
    personas: list[Persona],
) -> dict:
    """Convenience wrapper: run the debate, return (events, final stances, final camps)."""
    events: list[dict] = []
    stances: list[Stance] = []
    camps: list[Camp] = []
    async for ev in run_debate(session_id, question, business_class, evidence, personas):
        events.append(ev)
        if ev["type"] == "stance":
            stances.append(Stance(
                round=ev["round"], persona_id=ev["persona_id"], segment=ev["segment"],
                stance=ev["stance"], stance_label=ev["stance_label"], reason=ev["reason"],
                evidence_ids=ev["evidence_ids"], predicted_visits=ev.get("predicted_visits"),
            ))
        elif ev["type"] == "camp":
            camps.append(Camp(round=ev["round"], name=ev["camp"],
                              member_ids=ev["member_ids"], top_arguments=ev["top_arguments"]))
    return {"events": events, "stances": stances, "camps": camps}