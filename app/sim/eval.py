"""Final evaluation + chart data for the mock-market loop.

final_eval: regret of the loop's final decision vs the round-0 baseline
decision region, on held-out truths sampled from the SAME calibrated ranges
(different seeds) — plus shifted contexts the loop never trains on.
"""
from __future__ import annotations

from app.models import RoundScore
from app.sim.loop import _RUN_STATE
from app.sim.market import grid_best, regret_of


def final_eval(loop_result: list[RoundScore], test_truths: list[dict],
               contexts_override: dict | None = None) -> dict:
    """loop_result: rows returned by run_loop (train split). test_truths:
    truths sampled from the same ranges via sample_truth(ranges, other_seed).

    The final decision is the decision the LAST train round committed to
    (i.e. built from the final kept beliefs).

    contexts_override (derive_contexts' dict) replaces the hardcoded shifted
    contexts (playoff_weekend / new_competitor) with the override's held-out
    ("test") scenario contexts; None (default) = classic behavior.
    """
    rows = sorted(loop_result, key=lambda r: r.round)
    run_id = rows[0].run_id
    state = _RUN_STATE.get(run_id, {})
    final_decision = state.get("final_decision")

    baseline_regret = rows[0].regret
    final_regret = rows[-1].regret

    ov = contexts_override if isinstance(contexts_override, dict) else {}
    ctx_map = {str(c.get("name")).strip(): c
               for side in ("train", "test")
               for c in (ov.get(side) or [])
               if isinstance(c, dict) and str(c.get("name") or "").strip()}
    test_names = [str(c.get("name")).strip()
                  for c in (ov.get("test") or [])
                  if isinstance(c, dict) and str(c.get("name") or "").strip()] \
        or ["playoff_weekend", "new_competitor"]

    test_regret = None
    shifted_regret = None
    if final_decision is not None and test_truths:
        per_truth = []
        for truth in test_truths:
            best = grid_best("normal", truth)
            per_truth.append(regret_of(final_decision, "normal", truth, best=best))
        test_regret = round(sum(per_truth) / len(per_truth), 6)

        shifted = []
        for truth in test_truths[:2]:
            for ctx in test_names:
                best = grid_best(ctx, truth, contexts=ctx_map)
                shifted.append(regret_of(final_decision, ctx, truth, best=best,
                                         contexts=ctx_map))
        shifted_regret = round(sum(shifted) / len(shifted), 6) if shifted else None

    return {
        "baseline_regret": baseline_regret,
        "final_regret": final_regret,
        "test_regret": test_regret,
        "shifted_context_regret": shifted_regret,
    }


def chart_data(loop_result: list[RoundScore],
               eval_result: dict | None = None) -> dict:
    """Frontend shape: one regret line per train round + a final test bar."""
    rows = sorted(loop_result, key=lambda r: r.round)
    train = [{"round": r.round, "regret": r.regret,
              "prediction_error": r.prediction_error} for r in rows if r.split == "train"]
    test = [{"round": r.round, "regret": r.regret} for r in rows if r.split == "test"]
    data = {
        "train_line": train,
        "test_line": test,
        "final_test_bar": None,
    }
    if eval_result:
        data["final_test_bar"] = {
            "baseline_regret": eval_result.get("baseline_regret"),
            "final_regret": eval_result.get("final_regret"),
            "test_regret": eval_result.get("test_regret"),
            "shifted_context_regret": eval_result.get("shifted_context_regret"),
        }
    return data