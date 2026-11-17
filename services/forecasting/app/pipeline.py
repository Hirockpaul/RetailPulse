"""The forecasting run: evaluate models on time-ordered windows, pick one, forecast, persist.

compute() is pure (numpy in, numpy out) so it can be tested without a database; run_forecast()
wraps it with reading history and writing results to the `forecast` schema.
"""

from __future__ import annotations

import warnings
from collections.abc import Callable
from dataclasses import dataclass

import numpy as np

from app import repository
from app.config import (
    EVAL_HORIZON_DAYS,
    MIN_HISTORY_DAYS,
)
from app.data import History, load_history
from app.db import connect
from app.evaluation import intervals
from app.evaluation.backtest import (
    BASELINES,
    ML_MODEL,
    Selection,
    Windows,
    make_windows,
    rolling_forecast,
    score,
    score_by_horizon,
    score_range,
    select_model,
)
from app.models import baselines, ml

BASELINE_FUNCS: dict[str, Callable[[np.ndarray, int, int], np.ndarray]] = {
    "moving_average_28": lambda y, o, h: baselines.moving_average(y, o, h, 28),
    "seasonal_naive_7": lambda y, o, h: baselines.seasonal_naive(y, o, h, 7),
}
assert set(BASELINE_FUNCS) == set(BASELINES)

FALLBACK_MODEL = "category_average"


@dataclass
class Outcome:
    windows: Windows
    horizon: int
    # model -> split -> {mae, rmse, wape, bias, interval_coverage, interval_width, n_points, n_series}
    metrics: dict[str, dict[str, dict]]
    horizon_metrics: list[dict]  # {model, split, horizon_day, mae, wape, bias, n_points}
    feature_names: list[str]
    selection: Selection
    model_names: list[str]  # per series
    is_fallback: np.ndarray
    yhat: np.ndarray  # (series, horizon)
    lower: np.ndarray  # 80 % range (conformal, see evaluation/intervals.py)
    upper: np.ndarray
    lower95: np.ndarray
    upper95: np.ndarray
    # Per range level and forecast-level group: live quantiles + honest test coverage
    interval_groups: list[dict]
    avg_daily_28: np.ndarray
    std_daily_90: np.ndarray
    sigma: np.ndarray
    test_wape: np.ndarray


def _recent_stats(y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    last28 = y[:, -28:]
    last90 = y[:, -90:]
    with np.errstate(invalid="ignore"), warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        avg = np.nan_to_num(np.nanmean(last28, axis=1), nan=0.0)
        count = np.isfinite(last90).sum(axis=1)
        std = np.nan_to_num(np.nanstd(last90, axis=1, ddof=1), nan=0.0)
    return avg, np.where(count >= 2, std, 0.0)


def _fallback_values(
    hist: History, served: np.ndarray, avg: np.ndarray, std: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Category x store average of the series that have enough history (then category, then all)."""
    f_avg, f_std = avg.copy(), std.copy()
    if not served.any():
        return np.zeros_like(avg), np.zeros_like(std)
    for i in np.flatnonzero(~served):
        same_cat = served & (hist.category == hist.category[i])
        group = same_cat & (hist.store == hist.store[i])
        for candidates in (group, same_cat, served):
            if candidates.any():
                f_avg[i], f_std[i] = avg[candidates].mean(), std[candidates].mean()
                break
    return f_avg, f_std


def compute(
    hist: History, horizon: int, seed: int = 42, config: ml.FeatureConfig | None = None
) -> Outcome:
    n = hist.n_days
    w = make_windows(n)
    y = hist.y
    builder = ml.FeatureBuilder(hist, config)
    # Series with enough history before the first evaluation origin take part in the accuracy numbers.
    eligible = hist.start_idx <= (w.val_start - 1) - (ml.MIN_HISTORY_FOR_FEATURES - 1)
    spans = {"validation": (w.val_start, w.val_end), "test": (w.test_start, w.test_end)}
    actual = {split: y[:, s:e] for split, (s, e) in spans.items()}

    predictions: dict[str, dict[str, np.ndarray]] = {}
    for name, fn in BASELINE_FUNCS.items():
        predictions[name] = {
            split: rolling_forecast(lambda o, h, fn=fn: fn(y, o, h), s, e)
            for split, (s, e) in spans.items()
        }

    # The ML model is retrained for each split using only data BEFORE that split begins.
    models = {
        "validation": ml.train(builder, w.val_start - 1, horizon, seed),
        "test": ml.train(builder, w.test_start - 1, horizon, seed),
    }
    predictions[ML_MODEL] = {
        split: rolling_forecast(lambda o, h, m=models[split]: ml.predict(m, builder, o, h), s, e)
        for split, (s, e) in spans.items()
    }

    scores = {
        model: {split: score(actual[split], preds[split], eligible) for split in spans}
        for model, preds in predictions.items()
    }
    selection = select_model(scores)
    served_model = selection.model

    # Range quality, measured honestly: ranges for the TEST window are calibrated on the
    # VALIDATION window's errors only. (Live ranges are calibrated on both windows, below.)
    masks = {split: eligible[:, None] & np.isfinite(actual[split]) for split in spans}
    honest: dict[str, intervals.Calibration] = {}
    for model, preds in predictions.items():
        cal = intervals.calibrate(preds["validation"], actual["validation"], masks["validation"])
        honest[model] = cal
        for level, prefix in ((80, "interval"), (95, "interval95")):
            lower, upper = intervals.apply(cal, preds["test"], level)
            cov, width = score_range(actual["test"], lower, upper, masks["test"])
            scores[model]["test"].update({f"{prefix}_coverage": cov, f"{prefix}_width": width})
            scores[model]["validation"].update(
                {f"{prefix}_coverage": float("nan"), f"{prefix}_width": float("nan")}
            )
    horizon_metrics = [
        {"model": model, "split": split, **row}
        for model, preds in predictions.items()
        for split, (s, e) in spans.items()
        for row in score_by_horizon(actual[split], preds[split], eligible, s, e)
    ]

    if served_model == ML_MODEL:
        final = ml.train(builder, n - 1, horizon, seed)
        base_forecast = ml.predict(final, builder, n - 1, horizon)
    else:
        base_forecast = BASELINE_FUNCS[served_model](y, n - 1, horizon)

    avg28, std90 = _recent_stats(y)
    served = hist.history_days >= MIN_HISTORY_DAYS

    errors = np.hstack(
        [predictions[served_model][s] - actual[s] for s in spans]
    )  # typical forecast error per series, from the evaluation windows
    with np.errstate(invalid="ignore"), warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        backtest_rmse = np.sqrt(
            np.nanmean(np.where(np.isfinite(errors), errors, np.nan) ** 2, axis=1)
        )
    sigma = np.where(eligible & np.isfinite(backtest_rmse), backtest_rmse, std90)

    f_avg, f_std = _fallback_values(hist, served, avg28, std90)
    yhat = np.clip(np.where(served[:, None], base_forecast, f_avg[:, None]), 0.0, None)
    sigma = np.where(served, sigma, f_std)

    # Live ranges: the served model's errors from BOTH windows (more data, most recent included).
    live = intervals.calibrate(
        np.hstack([predictions[served_model][s] for s in spans]),
        np.hstack([actual[s] for s in spans]),
        np.hstack([masks[s] for s in spans]),
    )
    lower, upper = intervals.apply(live, yhat, 80)
    lower95, upper95 = intervals.apply(live, yhat, 95)
    interval_groups = []
    for level in intervals.LEVELS:
        test_cov, test_n = intervals.coverage_by_group(
            honest[served_model],
            predictions[served_model]["test"],
            actual["test"],
            masks["test"],
            level,
        )
        for g in range(len(live.edges) - 1):
            interval_groups.append(
                {
                    "level": level,
                    "group": g,
                    "forecast_from": live.edges[g],
                    "forecast_to": live.edges[g + 1],
                    "q_low": float(live.low[level][g]),
                    "q_high": float(live.high[level][g]),
                    "n_calibration": int(live.n_points[g]),
                    "pooled": bool(live.pooled[g]),
                    "test_coverage": float(test_cov[g]),
                    "test_points": int(test_n[g]),
                }
            )

    test_wape = np.where(eligible & served, scores[served_model]["test"]["series_wape"], np.nan)
    names = [served_model if s else FALLBACK_MODEL for s in served]
    flat_metrics = {
        model: {
            split: {k: v for k, v in sc.items() if not k.startswith("series_")}
            for split, sc in per_split.items()
        }
        for model, per_split in scores.items()
    }
    return Outcome(
        windows=w,
        horizon=horizon,
        metrics=flat_metrics,
        horizon_metrics=horizon_metrics,
        feature_names=builder.feature_names,
        selection=selection,
        model_names=names,
        is_fallback=~served,
        yhat=yhat,
        lower=lower,
        upper=upper,
        lower95=lower95,
        upper95=upper95,
        interval_groups=interval_groups,
        avg_daily_28=avg28,
        std_daily_90=std90,
        sigma=sigma,
        test_wape=test_wape,
    )


def run_forecast(run_id: str, horizon: int, seed: int = 42) -> None:
    """Background job: aggregate real sales, forecast, persist. Marks the run FAILED on error."""
    try:
        with connect() as conn:
            repository.aggregate_ledger(conn)
            conn.commit()
        with connect(read_only=True) as conn:
            hist = load_history(conn)
        outcome = compute(hist, horizon, seed)
        with connect() as conn:
            repository.save_results(conn, run_id, hist, outcome)
            conn.commit()
    except Exception as exc:
        with connect() as conn:
            repository.fail_run(conn, run_id, f"{type(exc).__name__}: {exc}"[:500])
            conn.commit()
        raise


__all__ = ["Outcome", "compute", "run_forecast", "EVAL_HORIZON_DAYS"]
