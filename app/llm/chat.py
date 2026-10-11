"""Persona agent chat (P1-3): post-debate interrogation in character.

The owner clicks a persona agent and asks it anything. The agent answers as
that customer — drawing on the persona profile, its recorded debate stance (if
it has one), the round-2 camp digest it saw (as far as events carry it), and
the session's evidence cards. It may concede honestly when the owner makes a
fair point: it's a simulated customer, not an oracle.

LLM access ONLY via app.llm.client.generate(). Zero network in tests: caller
monkeypatches client.generate (see tests/test_chat.py).

Stances/camps storage note (for the router): as of today main.py does NOT
persist stances/camps to the session doc — only verdict/personas/segments.
They exist as SSE events (`type: stance` / `type: camp`) in bus.backlog as
(event_type, json_payload) tuples. chat_with_agent accepts `debate_events` as
either a list of event dicts or backlog tuples; if the router later stores
them under doc["stances"]/["debates"], pass them straight through — the
helpers tolerate both.
"""
from __future__ import annotations

import json

from app.models import EvidenceCard, Stance
from app.llm import client
from app.llm.personas import _extract_json

EVIDENCE_PROMPT_CAP = 30          # same cap as debate.py
REPLY_WORD_CAP = 120
CHAT_MAX_TOKENS = 200             # ~120 words + JSON overhead headroom


def _plain(x) -> dict:
    return json.loads(json.dumps(x, default=str))


def _get(obj, name: str, default=None):
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _unwrap_events(events: list) -> list[dict]:
    """Normalize debate_events to a list of event dicts. Accepts plain event
    dicts and bus backlog (event_type, payload) tuples (payload str or dict)."""
    out: list[dict] = []
    for it in events or []:
        if isinstance(it, (tuple, list)) and len(it) == 2:
            et, payload = it
            data = payload
            try:
                data = json.loads(payload) if isinstance(payload, str) else payload
            except (ValueError, TypeError):
                continue
            if isinstance(data, dict):
                out.append({"type": et, **data})
        elif isinstance(it, dict):
            out.append(it)
    return out


# ---------------------------------------------------------------- stances + camps


def find_stance_for(persona_id: str, stances) -> Stance | None:
    """Latest-round Stance for this persona. Accepts Stance models, stance
    dicts, or stance event dicts (they carry the same keys). None if absent."""
    best: Stance | None = None
    for raw in stances or []:
        if isinstance(raw, (tuple, list)) and len(raw) == 2:
            raw = _unwrap_events([raw]) or [None]
            raw = raw[0] if raw else None
        if not isinstance(raw, (dict, Stance)):
            continue
        if str(_get(raw, "persona_id", "")) != persona_id:
            continue
        try:
            s = raw if isinstance(raw, Stance) else Stance(**_plain(raw))
        except Exception:  # noqa: BLE001
            continue
        if best is None or s.round > best.round:
            best = s
    return best


def _camp_digest_for(persona_id: str, events: list) -> str:
    """The camp the persona sat in, latest round: name + top_arguments. This is
    what camp events carry; the per-camp prose digest inside run_debate is not
    persisted, so the digest is best-effort from events."""
    best: dict | None = None
    for ev in _unwrap_events(events):
        if ev.get("type") != "camp":
            continue
        members = [str(m) for m in (ev.get("member_ids") or [])]
        if persona_id not in members:
            continue
        if best is None or int(ev.get("round", 0)) > int(best.get("round", 0)):
            best = ev
    if best is None:
        return ""
    name = str(best.get("camp", "")).strip()
    args = "; ".join(str(a).strip() for a in (best.get("top_arguments") or []) if str(a).strip())
    if name and args:
        return f"{name}: {args}"
    return name or args


# ---------------------------------------------------------------- system prompt


def persona_context(persona, own_stance: Stance | None, camp_digest: str | dict) -> list[dict]:
    """The in-character system prompt (one message). camp_digest may be a
    rendered string or a {...} of {name, top_arguments, digest}."""
    name = str(_get(persona, "name", "")).strip() or "this customer"
    segment = str(_get(persona, "segment", "")).strip()
    profile = str(_get(persona, "profile", "")).strip()
    src_ids = [str(x) for x in (_get(persona, "source_review_ids", []) or [])]

    if isinstance(camp_digest, dict):
        parts = [str(camp_digest.get("name", "")).strip()]
        digest = str(camp_digest.get("digest", "")).strip()
        args = "; ".join(str(a).strip() for a in (camp_digest.get("top_arguments") or []) if str(a).strip())
        for piece in (digest, args):
            if piece:
                parts.append(piece)
        camp_block = "YOUR CAMP IN THE DEBATE (you were in this group): " + " — ".join(p for p in parts if p)
    else:
        camp_block = "YOUR CAMP IN THE DEBATE (you were in this group): " + str(camp_digest or "").strip()
    if not camp_block.strip():
        camp_block = ""

    if own_stance is not None and str(_get(own_stance, "stance", "")):
        stance_block = f"""WHAT YOU SAID IN THE DEBATE (round {own_stance.round}):
- stance: {own_stance.stance} ("{own_stance.stance_label}")
- why you said it: {own_stance.reason}"""
    else:
        stance_block = (
            "You did NOT take part in the debate (no recorded stance). If asked about the "
            "question or the debate, answer honestly from your profile and the reviews you "
            "left, and say so naturally (e.g. \"I only read the reviews\")."
        )

    sys = f"""You are {name}, segment "{segment}". Profile: {profile}
Reviews this persona was built from: {", ".join(src_ids) or "(none)"}

{stance_block}
{camp_block}
You are now talking to the business owner one-on-one. Stay perfectly in character as this customer. Rules:
- Answer as {name} would: one short paragraph, AT MOST 120 words. Plain, casual, opinionated.
- Cite evidence_ids ONLY from the EVIDENCE list given in the next message. NEVER invent an id; use [] if none fit.
- If you did not take part in the debate (no stance above), answer from your profile and the reviews only, and say so naturally ("I only read the reviews").
- If the owner makes a point you find fair, you may concede honestly ("You make a fair point — I hadn't considered X"). You are a simulated customer, not an oracle.
- Reply ONLY with a single JSON object, no markdown."""

    return [
        {"role": "system", "content": sys},
        {"role": "system", "content":
            'Reply ONLY with: {"reply": "...", "evidence_ids": ["..."]} '
            f'("reply" <= {REPLY_WORD_CAP} words, in character).'},
    ]


# ---------------------------------------------------------------- entry point


async def chat_with_agent(
    persona: dict,
    message: str,
    evidence: list[dict],
    own_stance: Stance | None,
    debate_events: list,
    *,
    question: str = "",
) -> dict:
    """One in-character turn. Returns {"reply": str, "evidence_ids": [str]}.

    persona: Persona dict (or model) from the session doc's "personas".
    own_stance: this persona's Stance (or None / dict); if None, derived from
      debate_events.
    debate_events: stance + camp events (event dicts, or bus backlog
      (event_type, payload) tuples) for camp-digest context.
    question: the debate question, optional but recommended — pass doc["question"].
    """
    name = str(_get(persona, "name", "")).strip() or "this customer"
    stance: Stance | None = own_stance
    if isinstance(stance, dict):
        try:
            stance = Stance(**_plain(stance))
        except Exception:  # noqa: BLE001
            stance = None
    digest = _camp_digest_for(str(_get(persona, "id", "")), debate_events)
    if stance is None:
        stance = find_stance_for(str(_get(persona, "id", "")), debate_events)

    evidence_by_id, ev_lines = _normalize_evidence(evidence)

    question_block = (f"THE QUESTION UNDER DEBATE (asked of the customer group): "
                      f"{str(question).strip()}\n" if str(question or "").strip() else "")
    evidence_block = (f"\nEVIDENCE (one-line claims; cite id(s) that actually support "
                      f"your point, or use []):\n{ev_lines}\n")
    rules = ("\nRules:\n"
             "- Stay in character as the assigned customer persona.\n"
             f"- Maximum {REPLY_WORD_CAP} words.\n"
             "- Only cite evidence_ids from the list above; never invent one; [] if unsure.\n"
             f'Reply ONLY with: {{"reply": "...", "evidence_ids": ["..."]}}')

    messages = persona_context(persona, stance, digest)
    content = question_block + evidence_block + rules
    messages.append({"role": "system", "content": content})
    messages.append({"role": "user", "content": f"OWNER ASKS: {str(message or '').strip()}"})

    raw = await client.generate(
        messages, temperature=0.7, max_tokens=CHAT_MAX_TOKENS, json_mode=True,
        prefer="crowd",
    )

    reply_text, claimed_ids = "", []
    data = _extract_json(raw or "")
    if isinstance(data, dict):
        reply_text = str(data.get("reply", "")).strip()
        claimed_ids = [str(x) for x in (data.get("evidence_ids") or []) if str(x).strip()]
    if not reply_text:
        # lane down or unroutable reply -> deterministic in-character fallback
        reply_text = _fallback_reply(stance)
        claimed_ids = list(stance.evidence_ids) if stance is not None else []

    kept, seen = [], set()
    for i in claimed_ids:
        if i in evidence_by_id and i not in seen:
            kept.append(i)
            seen.add(i)

    return {"reply": _cap_words(reply_text), "evidence_ids": kept}


def _normalize_evidence(evidence: list) -> tuple[dict, str]:
    by_id: dict[str, EvidenceCard] = {}
    for raw in evidence or []:
        try:
            card = raw if isinstance(raw, EvidenceCard) else EvidenceCard(**_plain(raw))
            by_id[card.id] = card
        except Exception:  # noqa: BLE001
            continue
    lines = "\n".join(f"{c.id}: {c.claim}" for c in list(by_id.values())[:EVIDENCE_PROMPT_CAP])
    return by_id, lines or "(none)"


def _cap_words(text: str, cap: int = REPLY_WORD_CAP) -> str:
    text = str(text or "").strip()
    words = text.split()
    return text if len(words) <= cap else " ".join(words[:cap])


def _fallback_reply(stance: Stance | None) -> str:
    if stance is not None and (stance.reason or stance.stance_label):
        head = stance.stance_label and f"{stance.stance_label}."
        return f"{head} {stance.reason}".strip()
    return ("I only read the reviews, honestly — I didn't weigh in on the debate, "
            "so there's not much more I can tell you.")