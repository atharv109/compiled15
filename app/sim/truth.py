"""Truth calibration for the mock market.

Flow (anti-circularity):
  1. calibrate_ranges(reviews, segments, business_class) -> parameter RANGES,
     proposed by ONE cheap LLM call (json_mode) using the reviews + persona
     family hints. No key / total outage -> sane hardcoded fallback ranges.
  2. sample_truth(ranges, seed) -> ONE truth sampled inside each range with a
     pinned seed. Agents never see the truth; they only see outcome feedback.
  3. truth.json cache: save_truth / load_truth. Changing the seed and
     re-sampling is the "reroll" button.

reviews format (as produced by the pipeline): list[dict] with keys
  {"stars": int|None, "segment_hint": str, "text": str}
missing keys are tolerated.
"""
from __future__ import annotations

import json
import random
import re
from pathlib import Path

from app.models import PERSONA_FAMILY_HINTS
from app.llm import client as llm_client

TRUTH_PATH = Path(__file__).with_name("truth.json")

# ---- sane fallback ranges (used when no LLM key, or response unusable) ----
# values chosen to be plausible for a mid-size local consumer venue
_FALLBACK_RANGES = {
    "base_visits_wk_total": {"min": 120.0, "max": 420.0,
        "why": "fallback: walk-in traffic for a 100-300 cap venue"},
    "price_elasticity": {"min": 0.004, "max": 0.02,
        "why": "fallback: 1% price move shifts visits 0.4-2%"},
    "promo_amplitude": {"min": 0.15, "max": 0.45,
        "why": "fallback: promo lift caps at 15-45% visits, saturating"},
    "late_hours_labor_cost": {"min": 35.0, "max": 110.0,
        "why": "fallback: 2-3 late staff + overhead per extra hour"},
    "avg_ticket": {"min": 11.0, "max": 26.0,
        "why": "fallback: mid-tier check range"},
    "late_night_affinity": {"min": 0.10, "max": 0.45,
        "why": "fallback: late-night segment share-driven gain"},
    "appointment_density": {"min": 0.05, "max": 0.30,
        "why": "fallback: booked share of traffic"},
}

# business-class -> candidate adaptive knobs ("this business" selection)
_CLASS_KNOBS = {
    "local_consumer": ["late_night_affinity"],
    "b2b_service": ["appointment_density"],
    "regulated": ["appointment_density"],
    "startup": ["appointment_density"],
}

# global sanity clamps so a hallucinating LLM can never produce nonsense
_PARAM_CLAMPS = {
    "base_visits_wk_total": (20.0, 3000.0),
    "price_elasticity": (0.0005, 0.05),
    "promo_amplitude": (-0.5, 0.8),
    "late_hours_labor_cost": (0.0, 500.0),
    "avg_ticket": (3.0, 250.0),
    "late_night_affinity": (0.0, 0.8),
    "appointment_density": (0.0, 0.9),
}

_KNOB_NAMES = ("late_night_affinity", "appointment_density")


def _review_lines(reviews: list[dict], limit: int = 40) -> str:
    lines = []
    for r in reviews[:limit]:
        stars = r.get("stars")
        hint = (r.get("segment_hint") or "").strip()
        text = (r.get("text") or r.get("review") or "").strip()
        if not text:
            continue
        prefix = f"[{stars if stars is not None else '?'}]"
        if hint:
            prefix += f" [{hint}]"
        lines.append(f"{prefix} {text}")
    return "\n".join(lines)


def _clamp_range(name: str, lo: float, hi: float) -> dict | None:
    cap_lo, cap_hi = _PARAM_CLAMPS.get(name, (None, None))
    if cap_lo is None:  # unknown param name -> ignore
        return None
    try:
        lo, hi = float(lo), float(hi)
    except (TypeError, ValueError):
        return None
    if not (lo == lo and hi == hi):  # NaN check
        return None
    lo = max(lo, cap_lo)
    hi = min(hi, cap_hi)
    if hi < lo:
        lo, hi = hi, lo
    return {"min": round(lo, 6), "max": round(hi, 6)}


def _fallback_ranges(segments: list[str], business_class: str) -> dict:
    knobs = list(_CLASS_KNOBS.get(str(business_class), []))
    ranges = {k: dict(v) for k, v in _FALLBACK_RANGES.items()}
    return {"segments": list(segments), "knobs": knobs,
            "ranges": ranges, "source": "fallback"}


async def calibrate_ranges(
    reviews: list[dict],
    segments: list[str],
    business_class: str,
) -> dict:
    """Propose min/max per parameter from the reviews. ONE cheap LLM call.

    Never raises on LLM failure: degrades to fallback ranges with the same shape.
    """
    segments = list(dict.fromkeys(segments)) or ["general"]
    raw = await llm_client.generate(
        [
            {"role": "system", "content":
                "You are a demand-model calibration assistant. Respond with JSON only."},
            {"role": "user", "content": f"""Business class: {business_class}
Persona family hint: {PERSONA_FAMILY_HINTS.get(business_class, "")}
Emergent segments from the reviews: {segments}

Reviews (star rating, reviewer context hint, text):
{_review_lines(reviews)}

Propose PLAUSIBLE min/max ranges for this specific business's demand model
parameters. Every value must be consistent with what the reviews actually say
(the reviewer hints tell you WHO shows up; ratings tell you price sensitivity).
Pick which 0-2 adaptive knobs fit THIS business from: {list(_KNOB_NAMES)}
(late_night_affinity = gain from extra late opening hours, e.g. a bar;
 appointment_density = booked share of traffic, e.g. a clinic/salon).

JSON shape exactly:
{{
  "knobs": ["..."],
  "params": {{
    "base_visits_wk_total": {{"min": 0.0, "max": 0.0, "why": "one line"}},
    "price_elasticity": {{"min": 0.0, "max": 0.0, "why": "one line"}},
    "promo_amplitude": {{"min": 0.0, "max": 0.0, "why": "one line"}},
    "late_hours_labor_cost": {{"min": 0.0, "max": 0.0, "why": "one line"}},
    "avg_ticket": {{"min": 0.0, "max": 0.0, "why": "one line"}},
    "late_night_affinity": {{"min": 0.0, "max": 0.0, "why": "one line"}},
    "appointment_density": {{"min": 0.0, "max": 0.0, "why": "one line"}}
  }}
}}
Units: base_visits_wk_total = estimated total visits per week (all segments);
price_elasticity = fraction of visits lost per +1% price; promo_amplitude =
max fractional visit lift a promo can produce (saturates); late_hours_labor_cost
= $ per hour of extra late opening; avg_ticket = $ per visit; include a range
for BOTH knobs regardless of which you pick."""},
        ],
        temperature=0.2,
        max_tokens=700,
        json_mode=True,
    )
    if not raw:
        return _fallback_ranges(segments, business_class)
    try:
        parsed = json.loads(_extract_json(raw))
    except (ValueError, TypeError):
        return _fallback_ranges(segments, business_class)

    params = parsed.get("params", parsed) or {}
    knobs_in = parsed.get("knobs") or []
    knobs = [k for k in knobs_in if k in _KNOB_NAMES][:2]

    ranges: dict = {}
    for name, fallback in _FALLBACK_RANGES.items():
        got = params.get(name) or {}
        clamped = _clamp_range(name, got.get("min", 0), got.get("max", 0))
        if clamped is None:
            ranges[name] = dict(fallback)
        else:
            ranges[name] = {"min": clamped["min"], "max": clamped["max"],
                            "why": str(got.get("why", ""))[:160] or fallback["why"]}
    return {"segments": segments, "knobs": knobs, "ranges": ranges,
            "source": "llm"}


def _extract_json(text: str) -> str:
    """Tolerate fences / prose around the JSON object."""
    match = re.search(r"\{.*\}", text, re.S)
    return match.group(0) if match else text


# ---------------------------------------------------------------- sampling

def sample_truth(ranges: dict, seed: int) -> dict:
    """One truth sampled inside the calibrated ranges, fully seed-pinned.

    Truth is HIDDEN from agents: they only see outcome feedback.
    """
    rng = random.Random(f"truth|{seed}")
    segments = list(ranges.get("segments")) or ["general"]
    r = ranges["ranges"]

    def mid_range(name, jitter=1.0):
        spec = r[name]
        return rng.uniform(spec["min"], spec["max"]) * jitter

    total_base = mid_range("base_visits_wk_total")
    elasticity = mid_range("price_elasticity")
    promo_amp = mid_range("promo_amplitude")
    labor = mid_range("late_hours_labor_cost")
    ticket = mid_range("avg_ticket")

    knobs = list(ranges.get("knobs")) or _CLASS_KNOBS.get("local_consumer", [])
    knob_name = knobs[0] if knobs else "late_night_affinity"
    knob_val = mid_range(knob_name)

    # per-segment split of base traffic (seeded, hidden)
    raw_w = [rng.random() ** 1.3 for _ in segments]
    sw = sum(raw_w) or 1.0

    seg_params = {}
    for seg, w in zip(segments, raw_w):
        base = total_base * (w / sw)
        if knob_name == "late_night_affinity":
            late_amp = knob_val * rng.uniform(0.35, 1.65)
            elas_scale = 1.0
        else:  # appointment_density -> booked trade reduces elasticity
            late_amp = knob_val * 0.15 * rng.uniform(0.0, 1.0)
            elas_scale = max(0.2, 1.0 - knob_val * rng.uniform(0.6, 1.4))
        # promo response differs per segment; some segments are REPELLED by
        # promos (cheapening) — that makes promo not always the right answer
        amp = promo_amp * rng.uniform(0.45, 1.55)
        if rng.random() < 0.35:
            amp = -amp * rng.uniform(0.4, 0.8)
        seg_params[seg] = {
            "base_visits_wk": round(base, 3),
            "price_elasticity_scale": round(elas_scale * rng.uniform(0.8, 1.2), 4),
            "late_gain_amp": round(max(0.0, late_amp), 4),
            "promo_amp": round(amp, 4),
            "ctx": {
                "game_day": round(rng.uniform(0.0, 0.55), 3),
                "finals_week": round(rng.uniform(-0.05, 0.45), 3),
                "summer": round(rng.uniform(-0.3, 0.35), 3),
            },
        }

    return {
        "version": 1,
        "seed": int(seed),
        "segments": segments,
        "knob": knob_name,
        "global": {
            "price_elasticity": round(elasticity, 6),
            "promo_amplitude": round(promo_amp, 6),
            "late_hours_labor_cost": round(labor, 2),
            "avg_ticket": round(ticket, 2),
            "noise_scale": 0.06,
        },
        # late-night cliff: extra hours beyond this thin out — the 'obvious'
        # stay-open-late answer is actively wrong when the cliff + labor cost
        # exceed what the late-night segment contributes
        "late_cliff_hour": rng.choice([23, 24, 24, 25]),
        "base_closing_hour": 21,
        "segments_params": seg_params,
    }


def save_truth(truth: dict, path: Path | None = None) -> Path:
    p = Path(path) if path else TRUTH_PATH
    p.write_text(json.dumps(truth, indent=2), encoding="utf-8")
    return p


def load_truth(path: Path | None = None) -> dict | None:
    p = Path(path) if path else TRUTH_PATH
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return None