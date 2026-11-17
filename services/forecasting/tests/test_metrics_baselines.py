import numpy as np
import pytest

from app.evaluation.metrics import mae, rmse, wape
from app.models.baselines import moving_average, seasonal_naive


def test_metrics_known_values() -> None:
    actual = np.array([10.0, 0.0, 10.0])
    predicted = np.array([8.0, 2.0, 10.0])
    assert mae(actual, predicted) == pytest.approx(4 / 3)
    assert rmse(actual, predicted) == pytest.approx(np.sqrt(8 / 3))
    assert wape(actual, predicted) == pytest.approx(4 / 20)


def test_wape_is_nan_when_nothing_was_sold_and_zero_for_perfect() -> None:
    assert np.isnan(wape(np.zeros(3), np.ones(3)))
    assert wape(np.array([1.0, 2.0]), np.array([1.0, 2.0])) == 0.0


def test_moving_average_uses_only_the_last_window_up_to_origin() -> None:
    y = np.array([np.arange(1, 11, dtype=float)])  # 1..10
    out = moving_average(y, origin=5, horizon=3, window=3)  # days 4,5,6 -> values 4,5,6
    assert out.tolist() == [[5.0, 5.0, 5.0]]


def test_moving_average_ignores_days_before_a_series_started() -> None:
    y = np.array([[np.nan, np.nan, 2.0, 4.0]])
    assert moving_average(y, origin=3, horizon=1, window=28)[0, 0] == 3.0


def test_seasonal_naive_repeats_the_same_weekday() -> None:
    y = np.array([np.arange(14, dtype=float)])  # day index = value
    out = seasonal_naive(y, origin=13, horizon=9, period=7)
    # h=1 -> index 7, h=2 -> 8 ... h=7 -> 13, h=8 -> 7 (latest known same weekday), h=9 -> 8
    assert out[0].tolist() == [7, 8, 9, 10, 11, 12, 13, 7, 8]


def test_baselines_never_look_past_the_origin() -> None:
    rng = np.random.default_rng(0)
    y = rng.poisson(5, (4, 60)).astype(float)
    corrupted = y.copy()
    corrupted[:, 41:] = 9999.0  # the future, relative to origin 40
    for fn in (moving_average, seasonal_naive):
        assert np.array_equal(fn(y, 40, 7), fn(corrupted, 40, 7))


# ---------------------------------------------------------------- V2 step 1a


def test_bias_sign_and_size() -> None:
    from app.evaluation.metrics import bias

    actual = np.array([10.0, 10.0])
    assert bias(actual, np.array([11.0, 11.0])) == pytest.approx(0.1)  # 10 % over
    assert bias(actual, np.array([9.0, 9.0])) == pytest.approx(-0.1)  # 10 % under
    assert np.isnan(bias(np.zeros(2), np.ones(2)))


def test_interval_coverage_and_width() -> None:
    from app.evaluation.metrics import interval_coverage, interval_width

    actual = np.array([1.0, 5.0, 9.0, 3.0])
    lower, upper = np.full(4, 2.0), np.full(4, 8.0)
    assert interval_coverage(actual, lower, upper) == 0.25 * 2  # 5 and 3 are inside
    assert interval_width(lower, upper) == 6.0


def test_score_by_horizon_reports_each_day_ahead() -> None:
    from app.evaluation.backtest import horizon_days, score_by_horizon

    assert horizon_days(10, 24).tolist() == [1, 2, 3, 4, 5, 6, 7] * 2
    actual = np.ones((3, 14))
    predicted = actual + np.tile(np.arange(1, 8), 2)  # error grows with the horizon
    rows = score_by_horizon(actual, predicted, np.array([True, True, False]), 10, 24)
    assert [r["horizon_day"] for r in rows] == list(range(1, 8))
    assert [r["mae"] for r in rows] == pytest.approx(list(range(1, 8)))
    assert all(r["n_points"] == 2 * 2 for r in rows)  # 2 eligible series x 2 days each


def test_range_scoring_matches_the_nominal_level_when_errors_really_are_normal() -> None:
    from app.evaluation.backtest import score_range
    from app.evaluation.intervals import normal_band

    rng = np.random.default_rng(0)
    sigma = rng.uniform(1, 3, 400)
    predicted = np.full((400, 50), 100.0)
    actual = predicted + rng.normal(0, 1, (400, 50)) * sigma[:, None]
    lower, upper = normal_band(predicted, sigma, 1.2816)
    coverage, width = score_range(actual, lower, upper, np.ones_like(actual, bool))
    assert coverage == pytest.approx(0.80, abs=0.01)
    assert width == pytest.approx(2 * 1.2816 * sigma.mean(), rel=1e-6)
