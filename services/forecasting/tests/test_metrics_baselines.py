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
