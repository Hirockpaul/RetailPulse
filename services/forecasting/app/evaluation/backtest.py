"""Time-ordered evaluation: validation window, then a final untouched test window.

    |------------- train -------------|-- validation (28 d) --|-- test (28 d) --|
                                       ^ model choice          ^ honest score

Within a window the forecast is repeated from rolling origins every 7 days, each looking
1-7 days ahead, so every day of the window is predicted once, using only earlier data.
"""

from __future__ import annotations

import warnings
from collections.abc import Callable
from dataclasses import dataclass

import numpy as np

from app.config import EVAL_HORIZON_DAYS, EVAL_WINDOW_DAYS, MIN_HISTORY_DAYS
from app.evaluation.metrics import mae, rmse, wape

BASELINES = ("moving_average_28", "seasonal_naive_7")
ML_MODEL = "hgb_direct"


@dataclass(frozen=True)
class Windows:
    n_days: int
    val_start: int
    val_end: int  # exclusive
    test_start: int
    test_end: int  # exclusive


def make_windows(
    n_days: int, window: int = EVAL_WINDOW_DAYS, min_train: int = MIN_HISTORY_DAYS
) -> Windows:
    test_start = n_days - window
    val_start = test_start - window
    if val_start < min_train:
        raise ValueError(
            f"Need at least {min_train + 2 * window} days of history to forecast and evaluate "
            f"(found {n_days})."
        )
    return Windows(n_days, val_start, test_start, test_start, n_days)


def rolling_forecast(
    predict_fn: Callable[[int, int], np.ndarray],
    start: int,
    end: int,
    horizon: int = EVAL_HORIZON_DAYS,
) -> np.ndarray:
    """Forecast every day in [start, end). predict_fn(origin, horizon) may use data <= origin only."""
    chunks = []
    for origin in range(start - 1, end - 1, horizon):
        chunks.append(predict_fn(origin, min(horizon, end - 1 - origin)))
    return np.hstack(chunks)


def score(actual: np.ndarray, predicted: np.ndarray, eligible: np.ndarray) -> dict:
    """Pooled metrics over eligible series, plus a per-series WAPE and RMSE."""
    mask = eligible[:, None] & np.isfinite(actual)
    a, p = actual[mask], predicted[mask]
    err = np.where(mask, predicted - actual, np.nan)
    with np.errstate(invalid="ignore", divide="ignore"), warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # series without any eligible day
        sums = np.nansum(np.where(mask, actual, 0.0), axis=1)
        series_wape = np.where(sums > 0, np.nansum(np.abs(err), axis=1) / sums, np.nan)
        series_rmse = np.sqrt(np.nanmean(err**2, axis=1))
    return {
        "mae": mae(a, p),
        "rmse": rmse(a, p),
        "wape": wape(a, p),
        "n_points": int(mask.sum()),
        "n_series": int(eligible.sum()),
        "series_wape": series_wape,
        "series_rmse": series_rmse,
    }


@dataclass(frozen=True)
class Selection:
    model: str
    ml_beat_baseline: bool
    reason: str


def _lt(a: float, b: float) -> bool:
    return bool(np.isfinite(a) and np.isfinite(b) and a < b)


def select_model(metrics: dict[str, dict[str, dict]]) -> Selection:
    """Serve the machine-learning model only if it beats the best baseline's WAPE on BOTH the
    validation window and the untouched test window. Otherwise serve the best baseline.
    The best baseline is chosen on validation WAPE (never on test)."""
    baselines = [m for m in BASELINES if m in metrics]
    best = min(
        baselines,
        key=lambda m: (
            metrics[m]["validation"]["wape"]
            if np.isfinite(metrics[m]["validation"]["wape"])
            else float("inf")
        ),
    )
    b_val, b_test = metrics[best]["validation"]["wape"], metrics[best]["test"]["wape"]
    ml = metrics.get(ML_MODEL)
    if ml is None:
        return Selection(best, False, f"{best} served: no machine-learning model was evaluated.")

    m_val, m_test = ml["validation"]["wape"], ml["test"]["wape"]
    detail = (
        f"WAPE validation {m_val:.3f} vs {b_val:.3f} ({best}), test {m_test:.3f} vs {b_test:.3f}"
    )
    if _lt(m_val, b_val) and _lt(m_test, b_test):
        return Selection(
            ML_MODEL, True, f"{ML_MODEL} served: it beat {best} on validation and test. {detail}."
        )
    return Selection(
        best,
        False,
        f"{best} served: {ML_MODEL} did not beat it on both validation and test. {detail}.",
    )
