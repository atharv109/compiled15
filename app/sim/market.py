"""Deterministic mock-market demand model. NO LLM here.

visits_seg = base_visits_wk
             * price_eff        (visits drop per +1% price)
             * hours_eff        (late-night segment gain with an extra-hours CLIFF)
             * context_eff      (normal / game_day / finals_week / summer
                                 + held-out: playoff_weekend / new_competitor)
             * promo_eff        (SATURATING: diminishing jump to bigger promos)
             + seeded noise     (only when deterministic=False)

Revenue = sum(visits_seg * avg_ticket * (1 + price_change/100))
          - late_hours_labor_cost * extra_hours_over_baseline.
"""
from __future__ import annotations

import hashlib
import random

from app.models import SimDecision, SimOutcome

PRICE_GRID = [-20, -10, 0, 10, 20]
HOUR_GRID = [21, 22, 23, 24, 25, 26]           # 26 = 2 AM
PROMO_GRID = ["none", "student_deal", "game_day_special"]

PROMO_STRENGTH = {"none": 0.0, "student_deal": 0.7, "game_day_special": 1.0}

# peak fractional late-night gain at the cliff hour (shape of the ramp)
_LATE_PEAK = 0.35
_LATE_DECAY_PER_HOUR = 0.22    # gain decay per extra hour PAST the cliff
_PROMO_SAT_K = 0.7             # saturating promo: effect = amp * s/(s + K)

TRAIN_CONTEXTS = ("normal", "game_day", "finals_week", "summer")
HOLDOUT_CONTEXTS = ("playoff_weekend", "new_competitor")
HARDCODED_CONTEXTS = frozenset(("normal",) + TRAIN_CONTEXTS + HOLDOUT_CONTEXTS)


def _mult(value, lo: float, hi: float, default: float) -> float:
    """Clamped multiplier read for an evidence-derived context."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        v = default
    if v != v:  # NaN
        v = default
    return max(lo, min(hi, v))


def _derived_spec(context: str, contexts: dict | None):
    """multiplier spec for a derived context, or None when `context` is a
    hardcoded name (those keep their classic rulebook regardless of the map)
    or not present in the map."""
    if not contexts or context in HARDCODED_CONTEXTS:
        return None
    got = contexts.get(context)
    if not isinstance(got, dict):
        return None
    mbp = got.get("multiplier_by_param")
    if not isinstance(mbp, dict):
        return None
    # game_day 0 = the context does not touch the latent surge / promo lever
    return (
        _mult(mbp.get("game_day", 0.0), 0.0, 3.0, 0.0),
        _mult(mbp.get("late_night", 1.0), 0.5, 3.0, 1.0),
        _mult(mbp.get("price", 1.0), 0.5, 3.0, 1.0),
        _mult(mbp.get("traffic", 1.0), 0.5, 3.0, 1.0),
    )


def _hours_frac(extra: int, cliff_x: int) -> float:
    """Ramp of extra opening hours up to the cliff, decaying past it."""
    if extra <= 0:
        return 0.0
    c = max(1, cliff_x)
    if extra <= c:
        return _LATE_PEAK * extra / c
    return _LATE_PEAK * max(0.0, 1.0 - _LATE_DECAY_PER_HOUR * (extra - c))


def _context_load(seg_ctx: dict, context: str) -> float:
    """Per-segment traffic multiplier load for a context (0 = no effect)."""
    if context == "normal":
        return 0.0
    if context in seg_ctx:                      # game_day / finals_week / summer
        return float(seg_ctx[context])
    if context == "playoff_weekend":            # held-out: game-day signal amplified
        return float(seg_ctx.get("game_day", 0.0)) * 1.35 + 0.05
    if context == "new_competitor":             # held-out: traffic drain
        return -0.15
    return 0.0


def _noise_seed(truth: dict, decision: SimDecision, context: str) -> int:
    raw = (f"{truth.get('seed')}|{context}|{decision.price_change_pct}|"
           f"{decision.closing_hour}|{decision.promo}").encode("utf-8")
    return int.from_bytes(hashlib.sha256(raw).digest()[:8], "big")


def simulate(
    decision: SimDecision,
    context: str,
    truth: dict,
    deterministic: bool = True,
    contexts: dict | None = None,
) -> SimOutcome:
    """Same (decision, context, truth) -> same outcome. Pure: no I/O, no clock.

    `contexts` maps DERIVED context name -> {"name", "multiplier_by_param":
    {game_day, late_night, price, traffic}} (app/sim/contexts.py). Hardcoded
    names keep their classic rulebook even when named in the map; any other
    name found in the map executes via its multipliers:
      game_day   scales the segment's latent game-day surge + promo amplitude,
      late_night scales the late-hours gain, price scales elasticity, and
      traffic is a direct demand scalar (load = traffic - 1).
    """
    glob = truth["global"]
    pct = float(decision.price_change_pct)
    extra_start = int(truth.get("base_closing_hour", 21))
    extra = max(0, int(decision.closing_hour) - extra_start)
    cliff_x = max(1, int(truth.get("late_cliff_hour", 24)) - extra_start)
    strength = PROMO_STRENGTH.get(decision.promo, 0.0)
    promo_frac = strength / (strength + _PROMO_SAT_K) if strength > 0 else 0.0
    derived = _derived_spec(context, contexts)

    visits: dict[str, float] = {}
    promo_terms: list[float] = []
    late_fracs: list[float] = []
    for seg, sp in truth["segments_params"].items():
        elas = glob["price_elasticity"] * sp["price_elasticity_scale"]
        if context == "new_competitor":         # competitor attracts price-shoppers
            elas *= 1.6
        late_frac = _hours_frac(extra, cliff_x)
        if derived is not None:
            gd_m, ln_m, pr_m, tr_m = derived
            elas *= pr_m
            hours_eff = 1.0 + sp["late_gain_amp"] * ln_m * late_frac
            ctx_eff = max(0.0, 1.0 + float(sp["ctx"].get("game_day", 0.0)) * gd_m
                          + (tr_m - 1.0))
            promo_term = sp["promo_amp"] * promo_frac * gd_m
        else:
            hours_eff = 1.0 + sp["late_gain_amp"] * late_frac
            ctx_eff = 1.0 + _context_load(sp["ctx"], context)
            promo_term = sp["promo_amp"] * promo_frac  # saturating in promo strength
        price_eff = 1.0 - elas * pct
        promo_eff = 1.0 + promo_term

        v = sp["base_visits_wk"] * price_eff * hours_eff * ctx_eff * promo_eff
        visits[seg] = max(0.0, v)
        promo_terms.append(promo_term)
        late_fracs.append(late_frac)

    if not deterministic:
        rng = random.Random(_noise_seed(truth, decision, context))
        scale = glob.get("noise_scale", 0.05)
        visits = {seg: max(0.0, v * (1.0 + rng.uniform(-scale, scale)))
                  for seg, v in visits.items()}

    revenue = sum(visits.values()) * glob["avg_ticket"] * (1.0 + pct / 100.0)
    labor = max(0.0, glob["late_hours_labor_cost"]) * extra
    revenue -= labor

    mean_promo = sum(promo_terms) / len(promo_terms) if promo_terms else 0.0
    mean_late = sum(late_fracs) / len(late_fracs) if late_fracs else 0.0
    drift = -0.004 * pct + 0.06 * mean_promo + 0.12 * mean_late
    rating_drift = round(max(-1.0, min(1.0, drift)), 4)

    return SimOutcome(
        visits_by_segment={s: round(v, 4) for s, v in visits.items()},
        revenue=round(revenue, 4),
        rating_drift=rating_drift,
    )


# ------------------------------------------------------------------ regret

def grid_best(context: str, truth: dict, contexts: dict | None = None) -> float:
    """Best achievable revenue: brute force over the full decision grid."""
    best = None
    for pct in PRICE_GRID:
        for hour in HOUR_GRID:
            for promo in PROMO_GRID:
                out = simulate(SimDecision(
                    price_change_pct=pct, closing_hour=hour, promo=promo),
                    context, truth, deterministic=True, contexts=contexts)
                if best is None or out.revenue > best:
                    best = out.revenue
    return best


def regret_of(decision: SimDecision, context: str, truth: dict,
              best: float | None = None, contexts: dict | None = None) -> float:
    """(best_revenue - chosen_revenue) / best_revenue — 0.0 is perfect."""
    if best is None:
        best = grid_best(context, truth, contexts=contexts)
    out = simulate(decision, context, truth, deterministic=True, contexts=contexts)
    if abs(best) < 1e-12:
        return 0.0
    return (best - out.revenue) / abs(best)