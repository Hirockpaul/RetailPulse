"""Model comparison (V2 step 1d): same protocol as production, and the pre-registered rule."""

import pytest

from app import pipeline
from app.evaluation.compare import CandidateResult, decide, evaluate, train_random_forest
from app.models import ml
from tests.helpers import make_history


def result(name: str, val_wape: float) -> CandidateResult:
    return CandidateResult(name, {"wape": val_wape}, {"wape": 0.0}, 1.0)


def test_the_comparison_reproduces_the_production_evaluation_exactly() -> None:
    """Same windows, rows, origins and metrics: hgb scored here equals hgb scored by the pipeline."""
    hist = make_history(days=200)
    production = pipeline.compute(hist, 14).metrics["hgb_direct"]
    here = evaluate(hist, "hgb", ml.train, 42)
    for split in ("validation", "test"):
        for metric in ("wape", "mae", "rmse", "bias", "n_points"):
            assert getattr(here, split)[metric] == pytest.approx(production[split][metric])
    assert here.test["interval_coverage"] == pytest.approx(production["test"]["interval_coverage"])


def test_the_random_forest_candidate_trains_and_is_scored_on_both_windows() -> None:
    hist = make_history(n_products=12, days=200)
    r = evaluate(hist, "random_forest", train_random_forest, 42)
    assert 0 < r.validation["wape"] < 2 and 0 < r.test["wape"] < 2
    assert 0 <= r.test["interval_coverage"] <= 1


@pytest.mark.parametrize(
    ("candidate_wape", "passes"),
    [(0.500, True), (0.505, True), (0.5055, False), (0.510, False), (0.520, False)],
)
def test_the_rule_needs_half_a_point_better_on_validation(
    candidate_wape: float, passes: bool
) -> None:
    verdict = decide(result("prod", 0.510), result("cand", candidate_wape))
    assert ("PASSES" in verdict) is passes
    assert ("does NOT pass" in verdict) is (not passes)


def test_the_rule_ignores_the_test_window() -> None:
    production = CandidateResult("prod", {"wape": 0.51}, {"wape": 0.60}, 1.0)
    candidate = CandidateResult("cand", {"wape": 0.52}, {"wape": 0.40}, 1.0)  # great on test only
    assert "does NOT pass" in decide(production, candidate)
