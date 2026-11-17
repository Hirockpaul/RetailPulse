import numpy as np
import pytest

from app.evaluation.backtest import make_windows, rolling_forecast, score, select_model


def test_windows_are_ordered_adjacent_and_do_not_overlap() -> None:
    w = make_windows(200)
    assert w.val_start < w.val_end == w.test_start < w.test_end == 200
    assert w.val_end - w.val_start == w.test_end - w.test_start == 28
    assert w.val_start >= 56  # a minimum of training history remains


def test_windows_refuse_too_little_history() -> None:
    with pytest.raises(ValueError, match="at least"):
        make_windows(100)


def test_rolling_forecast_predicts_every_day_once_using_only_earlier_origins() -> None:
    calls: list[tuple[int, int]] = []

    def predict(origin: int, horizon: int) -> np.ndarray:
        calls.append((origin, horizon))
        return np.full((2, horizon), float(origin))

    start, end = 100, 128
    out = rolling_forecast(predict, start, end)
    assert out.shape == (2, 28)
    assert [o for o, _ in calls] == [99, 106, 113, 120]  # origins strictly before their targets
    assert all(o < start + 7 * i + 1 for i, (o, _) in enumerate(calls))
    # target day d is predicted from the latest origin before it
    assert out[0, 0] == 99 and out[0, 7] == 106 and out[0, 27] == 120


def test_score_pools_metrics_over_eligible_series_only() -> None:
    actual = np.array([[10.0, 10.0], [5.0, 5.0], [100.0, 100.0]])
    predicted = np.array([[8.0, 12.0], [5.0, 5.0], [0.0, 0.0]])
    eligible = np.array([True, True, False])  # the third series is excluded
    s = score(actual, predicted, eligible)
    assert s["n_points"] == 4 and s["n_series"] == 2
    assert s["wape"] == pytest.approx(4 / 30)
    assert s["mae"] == pytest.approx(1.0)
    assert s["series_wape"][0] == pytest.approx(4 / 20) and s["series_wape"][1] == 0.0


def test_score_ignores_missing_actuals() -> None:
    actual = np.array([[np.nan, 10.0]])
    s = score(actual, np.array([[3.0, 9.0]]), np.array([True]))
    assert s["n_points"] == 1 and s["wape"] == pytest.approx(0.1)


def metrics(
    ma: tuple[float, float], sn: tuple[float, float], ml: tuple[float, float] | None
) -> dict:
    def block(v: tuple[float, float]) -> dict:
        return {"validation": {"wape": v[0]}, "test": {"wape": v[1]}}

    out = {"moving_average_28": block(ma), "seasonal_naive_7": block(sn)}
    if ml is not None:
        out["hgb_direct"] = block(ml)
    return out


def test_ml_is_served_only_when_it_beats_the_best_baseline_on_validation_and_test() -> None:
    sel = select_model(metrics((0.40, 0.42), (0.50, 0.55), (0.30, 0.35)))
    assert sel.model == "hgb_direct" and sel.ml_beat_baseline
    assert "validation and test" in sel.reason


@pytest.mark.parametrize(
    "ml",
    [(0.45, 0.35), (0.30, 0.50), (0.40, 0.42), (float("nan"), 0.30), (0.30, float("nan"))],
)
def test_otherwise_the_best_baseline_is_served(ml: tuple[float, float]) -> None:
    sel = select_model(metrics((0.40, 0.42), (0.50, 0.55), ml))
    assert sel.model == "moving_average_28" and not sel.ml_beat_baseline
    assert "did not beat" in sel.reason


def test_the_baseline_is_chosen_on_validation_never_on_test() -> None:
    # seasonal_naive looks better on TEST, but moving_average wins validation: it must be chosen.
    sel = select_model(metrics((0.40, 0.60), (0.45, 0.30), None))
    assert sel.model == "moving_average_28"


def test_without_an_ml_model_a_baseline_is_served() -> None:
    sel = select_model(metrics((0.5, 0.5), (0.4, 0.4), None))
    assert sel.model == "seasonal_naive_7" and not sel.ml_beat_baseline
