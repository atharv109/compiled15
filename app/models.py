"""Pinned internal data models. Backend agents MUST code against these shapes.
These mirrors docs/api-contract.md — changes require coordinating via main user."""

from __future__ import annotations
from enum import Enum
from typing import Literal
from pydantic import BaseModel, Field

class BusinessClass(str, Enum):
    local_consumer = "local_consumer"   # cafe, bar, salon, shop
    startup = "startup"                 # product company, seeking users/investors
    b2b_service = "b2b_service"         # procurement/finance/legal persona families
    regulated = "regulated"            # clinic, law, nonprofit

# persona families selected by business class
PERSONA_FAMILY_HINTS = {
    "local_consumer": "walk-ins, regulars, tourists, students, families, staff-adjacent loyalists",
    "startup": "early users, skeptical devs, investors, hiring engineers, churned users",
    "b2b_service": "procurement leads, finance sign-off, IT/security reviewers, end users, executive sponsors",
    "regulated": "patients/clients, compliance reviewers, referral partners, staff, community members",
}

class EvidenceCard(BaseModel):
    id: str
    claim: str                       # one sentence
    source_url: str
    source_label: str                # human name shown on card
    type: Literal["review", "price", "competitor", "event", "profile",
                  "public_info", "weather", "calendar"]
    quote: str | None = None         # exact verbatim excerpt where possible

class Persona(BaseModel):
    id: str
    segment: str                     # emergent segment name
    name: str                        # human handle, e.g. "Sam the junior"
    profile: str                     # 2-3 sentences in-character background
    source_review_ids: list[str]     # evidence ids this persona was built from
    weight: float = 1.0              # segment prevalence among reviewers

class Stance(BaseModel):
    round: int
    persona_id: str
    segment: str
    stance: Literal["support", "oppose", "neutral"]
    stance_label: str                # short human text for UI
    reason: str                      # <=2 sentences, in-character
    evidence_ids: list[str]
    predicted_visits: dict[str, float] | None = None   # loop rounds only

class Camp(BaseModel):
    round: int
    name: str
    member_ids: list[str]
    top_arguments: list[str]

class SegmentImpact(BaseModel):
    segment: str
    impact: str
    evidence_ids: list[str]

class Verdict(BaseModel):
    recommendation: str
    confidence: float                # 0..1
    tally: dict                      # {"support": n, "oppose": n, "neutral": n}
    objections: list[str]            # top 3, strongest first
    segment_impact: list[SegmentImpact]

# ---- simulator ----

class SimDecision(BaseModel):
    price_change_pct: float = Field(..., ge=-20, le=20)
    closing_hour: int                # 21..26 (26 = 2 AM)
    promo: Literal["none", "student_deal", "game_day_special"]

class SimOutcome(BaseModel):
    visits_by_segment: dict[str, float]
    revenue: float
    rating_drift: float

class RoundScore(BaseModel):
    run_id: str
    round: int
    regret: float                    # (best - chosen) / best
    prediction_error: float          # mean abs pred vs actual per segment
    split: Literal["train", "test"]