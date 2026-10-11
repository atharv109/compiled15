"""Classify business from name + Tavily snippet text into a BusinessClass enum
value. One cheap json_mode LLM call; heuristic fallback: local_consumer."""
from __future__ import annotations

import json
import logging

from app.models import BusinessClass

log = logging.getLogger("business_class")

# keyword triage so an offline/no-key run still lands somewhere sane
_STRONG_HINTS = {
    "startup": ("startup", "labs", "saas", "inc", "technologies", "platform", "app "),
    "regulated": ("clinic", "dental", "law", "attorney", "nonprofit", "medical", "veterinary"),
    "b2b_service": ("consulting", "agency llc", "solutions", "enterprise", "logistics", "wholesale"),
}
_CONSUMER_HINTS = ("cafe", "coffee", "bar", "grill", "bakery", "salon", "pizza", "restaurant", "shop", "studio", "tavern", "brewery")


def classify(business_class_value: str) -> BusinessClass:
    try:
        return BusinessClass(business_class_value)
    except ValueError:
        return BusinessClass.local_consumer


HEURISTIC_ORDER = ("startup", "regulated", "b2b_service", "local_consumer")

async def detect(business_name: str, town: str, search_text: str = "") -> BusinessClass:
    """search_text: any Tavily snippet/description text; may be empty."""
    text = f"{business_name} {town} {search_text}".strip()
    reply = None
    try:
        from app.llm import client as llm

        reply = await llm.generate(
            [
                {"role": "system", "content": "You classify businesses. Reply ONLY with a JSON object."},
                {"role": "user", "content": f"""Classify this business into exactly one class:
- local_consumer: cafe, bar, salon, restaurant, shop, walk-in consumer services
- startup: product company, seeking users/investors
- b2b_service: procurement/finance/legal serving business clients
- regulated: clinic, law practice, nonprofit, compliance-sensitive

TEXT:
{text[:1500]}

Reply ONLY with: {{"business_class": "..."}}"""},
            ],
            temperature=0,
            max_tokens=500,
            json_mode=True,
        )
    except Exception as e:  # noqa: BLE001
        log.warning("business_class LLM call failed: %s", e)

    if reply:
        try:
            raw = json.loads(reply).get("business_class", "")
            val = str(raw).strip().lower()
            if val in BusinessClass.__members__ or val in {m.value for m in BusinessClass}:
                return classify(val)
        except Exception:  # noqa: BLE001
            pass
        log.warning("business_class unparsable reply: %r", reply[:120])

    low = text.lower()
    for cls in HEURISTIC_ORDER[:-1]:
        if any(h in low for h in _STRONG_HINTS.get(cls, ())):
            return BusinessClass(cls)
    if any(h in low for h in _CONSUMER_HINTS):
        return BusinessClass.local_consumer
    return BusinessClass.local_consumer  # spec fallback