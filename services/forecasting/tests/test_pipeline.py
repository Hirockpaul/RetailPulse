"""compute(): the whole forecasting run on in-memory data (no database)."""

import numpy as np
import pytest

from app.data import History
from app.pipeline import FALLBACK_MODEL, compute
from tests.helpers import make_history


@pytest.fixture(scope="module")
def hist() -> History:
    return make_history(n_products=20, n_stores=2, days=210, seed=21, new_share=0.15)


@pytest.fixture(scope="module")
def outcome(hist: History):
    return compute(hist, horizon=14, seed=5)


def test_shapes_and_basic_sanity(hist: History, outcome) -> None:
    assert outcome.yhat.shape == outcome.lower.shape == outcome.upper.shape == (hist.n_series, 14)
    assert (outcome.yhat >= 0).all() and (outcome.lower >= 0).all()
    assert (outcome.lower <= outcome.yhat + 1e-9).all() and (
        outcome.upper >= outcome.yhat - 1e-9
    ).all()
    assert np.isfinite(outcome.sigma).all() and (outcome.sigma >= 0).all()


def test_all_three_models_are_scored_on_validation_and_test(outcome) -> None:
    assert set(outcome.metrics) == {"moving_average_28", "seasonal_naive_7", "hgb_direct"}
    for per_split in outcome.metrics.values():
        assert set(per_split) == {"validation", "test"}
        for m in per_split.values():
            assert m["n_points"] > 0 and m["mae"] >= 0 and m["rmse"] >= m["mae"] - 1e-9
            assert 0 <= m["wape"] < 5


def test_the_served_model_follows_the_selection_rule(outcome) -> None:
    m = outcome.metrics
    best = min(("moving_average_28", "seasonal_naive_7"), key=lambda k: m[k]["validation"]["wape"])
    ml_wins = (
        m["hgb_direct"]["validation"]["wape"] < m[best]["validation"]["wape"]
        and m["hgb_direct"]["test"]["wape"] < m[best]["test"]["wape"]
    )
    assert outcome.selection.ml_beat_baseline == ml_wins
    assert outcome.selection.model == ("hgb_direct" if ml_wins else best)
    assert outcome.selection.reason


def test_short_history_series_use_the_flagged_category_average(hist: History, outcome) -> None:
    short = hist.history_days < 56
    assert short.any() and (~short).any()
    assert (outcome.is_fallback == short).all()
    assert all(outcome.model_names[i] == FALLBACK_MODEL for i in np.flatnonzero(short))
    for i in np.flatnonzero(short):
        assert np.allclose(outcome.yhat[i], outcome.yhat[i, 0])  # flat forecast
        assert outcome.yhat[i, 0] > 0  # taken from comparable series, not zero
    assert outcome.metrics["hgb_direct"]["test"]["n_series"] <= int((~short).sum())


def test_fallback_series_are_excluded_from_the_accuracy_numbers(hist: History, outcome) -> None:
    eligible_max = int((hist.history_days >= 56 + 28 + 28).sum())
    assert outcome.metrics["moving_average_28"]["test"]["n_series"] <= eligible_max + (
        hist.n_series - eligible_max
    )
    assert outcome.metrics["moving_average_28"]["test"]["n_series"] < hist.n_series


def test_the_test_window_never_influences_validation_scores_or_model_training(
    hist: History,
) -> None:
    """Scrambling the test window must leave every validation metric untouched."""
    base = compute(hist, horizon=7, seed=5)
    y = hist.y.copy()
    test_start = base.windows.test_start
    y[:, test_start:] = np.where(np.isfinite(y[:, test_start:]), 777.0, np.nan)
    altered = compute(History(**{**hist.__dict__, "y": y}), horizon=7, seed=5)
    for model in base.metrics:
        a, b = base.metrics[model]["validation"], altered.metrics[model]["validation"]
        assert a["wape"] == pytest.approx(b["wape"]), model
        assert a["mae"] == pytest.approx(b["mae"]), model
    # ...while the test scores do change (the data really was altered)
    assert base.metrics["moving_average_28"]["test"]["wape"] != pytest.approx(
        altered.metrics["moving_average_28"]["test"]["wape"]
    )


def test_a_run_is_deterministic_for_a_seed(hist: History, outcome) -> None:
    again = compute(hist, horizon=14, seed=5)
    assert np.array_equal(outcome.yhat, again.yhat)
    assert outcome.selection == again.selection


def test_too_little_history_is_a_clear_error() -> None:
    with pytest.raises(ValueError, match="at least"):
        compute(make_history(days=90, new_share=0.0), horizon=7)


def test_ranges_are_conformal_nested_and_their_test_coverage_is_reported() -> None:
    from app.evaluation import intervals

    hist = make_history(days=200)
    out = compute(hist, 7)
    assert (out.lower95 <= out.lower).all() and (out.lower <= out.yhat).all()
    assert (out.yhat <= out.upper).all() and (out.upper <= out.upper95).all()
    groups = len(intervals.LEVEL_EDGES) - 1
    assert len(out.interval_groups) == 2 * groups
    checked = [g for g in out.interval_groups if g["test_points"] > 0]
    assert checked and all(0 <= g["test_coverage"] <= 1 for g in checked)
    served = out.metrics[out.selection.model]["test"]
    assert 0 < served["interval_coverage"] < served["interval95_coverage"] <= 1
