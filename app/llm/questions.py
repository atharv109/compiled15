"""Small helper: 3-4 example decision questions for the UI hint box. UI sugar only."""
from __future__ import annotations
from app.models import EvidenceCard, PERSONA_FAMILY_HINTS
from app.llm import client
from app.llm.personas import _extract_json

_DEFAULTS = {
    "local_consumer": ["Should we stay open later on weekends?",
                       "Should we raise prices 10%?",
                       "Should we add a loyalty discount for regulars?"],
    "startup": ["Should we sunset the free tier?",
                "Which feature should we build next?",
                "Is it time to raise prices for new users?"],
    "b2b_service": ["Should we require annual contracts?",
                    "Should we add an enterprise support tier?",
                    "Should we raise the implementation fee?"],
    "regulated": ["Should we extend hours into the evening?",
                  "Should we add a self-service option?",
                  "Should we expand to a second location?"],
}


async def example_questions(business: dict | str, evidence: list[EvidenceCard],
                            business_class: str = "local_consumer") -> list[str]:
    name = business.get("name", "") if isinstance(business, dict) else str(business)
    town = business.get("town", "") if isinstance(business, dict) else ""
    raw = await client.generate(
        [
            {"role": "system", "content": "You ask sharp, specific decision questions a small-business owner would actually want customer feedback on. Reply ONLY with a JSON object."},
            {"role": "user", "content": f"""Business: {name or 'this business'}{f' ({town})' if town else ''}
Type: {business_class}. Typical customer families: {PERSONA_FAMILY_HINTS.get(business_class, '')}
What the reviews mention:
{chr(10).join(f'- {e.claim}' for e in evidence[:15])}

Write 3-4 concrete decision questions this owner might ask their customer swarm (e.g. "Should we stay open until 2 AM on football Saturdays?"). Each question must be answerable with support/oppose/neutral.

Reply ONLY with: {{"questions": ["...", "..."]}}"""},
        ],
        temperature=0.6, max_tokens=300, json_mode=True,
    )
    data = _extract_json(raw or "") or {}
    qs = [q.strip() for q in (data.get("questions") or []) if str(q).strip()]
    if not qs:
        qs = list(_DEFAULTS.get(business_class, _DEFAULTS["local_consumer"]))
    return qs[:4]