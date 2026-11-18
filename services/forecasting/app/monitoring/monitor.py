"""Model monitoring (V2 step 3c-1): data drift, prediction drift and accuracy on new days.

Pure computation on a loaded `History`; the repository loads inputs and stores results. Rules
(fixed before building): docs/V2-PLAN.md step 3c-1. Monitoring only describes the ACTIVE model:
nothing here retrains, activates or changes a forecast.

  reference = the last 28 days up to the ACTIVE model's training_end
  current   = the complete days after training_end (at most the latest 28); < 7 → INSUFFICIENT_DATA
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import date

import numpy as np

from app.data import History
from app.models.ml import MIN_HISTORY_FOR_FEATURES, FeatureBuilder
from app.monitoring.drift import INSUFFICIENT, Drift, compare, worst

WINDOW_DAYS = 28
MIN_CURRENT_DAYS = 7
MIN_ACCURACY_DAYS = 7
MIN_ACCURACY_POINTS = 1000
DEGRADED_WAPE_GAP = 0.05
DEGRADED_ABS_BIAS = 0.10
DRIFT_FEATURES = (
    "mean_7d",
    "mean_28d",
    "mean_56d",
    "std_28d",
    "last_same_weekday",
    "ratio_7d_28d",
)

# Day-1 forecast of the ACTIVE model for every series at an origin (artifact or baseline rule).
PredictDay1 = Callable[[FeatureBuilder, int], np.ndarray]


@dataclass(frozen=True)
class MonitoringWindows:
    training_end: date
    latest_data_day: date
    reference: tuple[int, int] | None  # inclusive day indices
    current: tuple[int, int] | None
    current_days: int

    @property
    def enough(self) -> bool:
        return self.current_days >= MIN_CURRENT_DAYS


@dataclass(frozen=True)
class CheckResult:
    check_kind: str  # FEATURE | STORE_SALES | PREDICTION | PERFORMANCE
    subject: str
    status: str
    location_id: str | None = None
    drift: Drift | None = None
    wape: float | None = None
    bias: float | None = None
    backtest_wape: float | None = None
    n_points: int | None = None
    n_days: int | None = None


@dataclass(frozen=True)
class PointsSample:
    """Forecast points of kept runs: product, store, target day and forecast (days 1-7)."""

    product_ids: list[str]
    location_ids: list[str]
    target_days: list[date]
    yhat: np.ndarray


@dataclass(frozen=True)
class MonitoringOutcome:
    windows: MonitoringWindows
    results: list[CheckResult]
    data_drift_status: str
    prediction_drift_status: str
    performance_status: str


def _day(hist: History, idx: int) -> date:
    return hist.days[idx].astype("datetime64[D]").astype(date)


def windows_for(hist: History, training_end: date) -> MonitoringWindows:
    n = hist.n_days
    first = hist.days[0].astype("datetime64[D]").astype(date)
    te = min((training_end - first).days, n - 1)
    reference = (max(te - WINDOW_DAYS + 1, 0), te) if te >= 0 else None
    current = (max(te + 1, n - WINDOW_DAYS), n - 1) if te + 1 <= n - 1 else None
    days = current[1] - current[0] + 1 if current else 0
    return MonitoringWindows(training_end, _day(hist, n - 1), reference, current, days)


def _eligible(builder: FeatureBuilder, hist: History, origin: int) -> np.ndarray:
    """Series that the model could forecast from this origin (enough history, observed)."""
    return (origin - hist.start_idx >= MIN_HISTORY_FOR_FEATURES - 1) & np.isfinite(
        hist.y[:, origin]
    )


def _feature_samples(
    builder: FeatureBuilder, hist: History, span: tuple[int, int] | None
) -> dict[str, np.ndarray]:
    names = builder.feature_names
    cols = {f: names.index(f) for f in DRIFT_FEATURES}
    parts: dict[str, list[np.ndarray]] = {f: [] for f in DRIFT_FEATURES}
    if span is not None:
        for origin in range(span[0], span[1] + 1):
            ok = _eligible(builder, hist, origin)
            if not ok.any():
                continue
            x = builder.features(origin, 1)[ok]
            for f, c in cols.items():
                parts[f].append(x[:, c])
    return {f: np.concatenate(p) if p else np.empty(0) for f, p in parts.items()}


def _predictions(
    builder: FeatureBuilder, hist: History, span: tuple[int, int] | None, predict: PredictDay1
) -> np.ndarray:
    parts: list[np.ndarray] = []
    if span is not None:
        for origin in range(span[0], span[1] + 1):
            ok = _eligible(builder, hist, origin)
            if ok.any():
                parts.append(np.asarray(predict(builder, origin), dtype=float)[ok])
    return np.concatenate(parts) if parts else np.empty(0)


def _store_sales(hist: History, span: tuple[int, int] | None, rows: np.ndarray) -> np.ndarray:
    if span is None or not rows.any():
        return np.empty(0)
    block = hist.y[rows, span[0] : span[1] + 1]
    return block[np.isfinite(block)]


def accuracy(hist: History, points: PointsSample, backtest_wape: float | None) -> CheckResult:
    """Realized WAPE and bias of kept forecasts on days that now have data (no row = 0 units)."""
    index = {
        (p, loc): i
        for i, (p, loc) in enumerate(zip(hist.product_ids, hist.location_ids, strict=True))
    }
    first = hist.days[0].astype("datetime64[D]").astype(date)
    errors, actuals, days = [], [], set()
    for p, loc, d, f in zip(
        points.product_ids, points.location_ids, points.target_days, points.yhat, strict=True
    ):
        s = index.get((p, loc))
        k = (d - first).days
        if s is None or k < 0 or k >= hist.n_days or not np.isfinite(hist.y[s, k]):
            continue
        actual = float(hist.y[s, k])
        errors.append(float(f) - actual)
        actuals.append(actual)
        days.add(d)
    n_points, total = len(errors), float(np.sum(actuals)) if actuals else 0.0
    wape = float(np.sum(np.abs(errors)) / total) if total > 0 else None
    bias = float(np.sum(errors) / total) if total > 0 else None
    if len(days) < MIN_ACCURACY_DAYS or n_points < MIN_ACCURACY_POINTS or wape is None:
        status = INSUFFICIENT
    elif (backtest_wape is not None and wape > backtest_wape + DEGRADED_WAPE_GAP) or (
        bias is not None and abs(bias) > DEGRADED_ABS_BIAS
    ):
        status = "DEGRADED"
    else:
        status = "OK"
    return CheckResult(
        "PERFORMANCE",
        "kept_runs",
        status,
        wape=wape,
        bias=bias,
        backtest_wape=backtest_wape,
        n_points=n_points,
        n_days=len(days),
    )


def compute(
    hist: History,
    training_end: date,
    model_name: str,
    predict: PredictDay1,
    points: PointsSample,
    backtest_wape: float | None,
    store_codes: dict[str, str],
) -> MonitoringOutcome:
    w = windows_for(hist, training_end)
    builder = FeatureBuilder(hist)
    results: list[CheckResult] = []

    ref_f = _feature_samples(builder, hist, w.reference)
    cur_f = _feature_samples(builder, hist, w.current) if w.enough else {}
    for f in DRIFT_FEATURES:
        d = compare(ref_f[f], cur_f.get(f, np.empty(0)), w.enough)
        results.append(CheckResult("FEATURE", f, d.status, drift=d))

    stores = np.array(hist.location_ids)
    for loc in sorted(set(hist.location_ids), key=lambda x: store_codes.get(x, x)):
        rows = stores == loc
        d = compare(
            _store_sales(hist, w.reference, rows),
            _store_sales(hist, w.current, rows) if w.enough else np.empty(0),
            w.enough,
        )
        results.append(
            CheckResult(
                "STORE_SALES", store_codes.get(loc, loc), d.status, location_id=loc, drift=d
            )
        )

    d = compare(
        _predictions(builder, hist, w.reference, predict),
        _predictions(builder, hist, w.current, predict) if w.enough else np.empty(0),
        w.enough,
    )
    results.append(CheckResult("PREDICTION", model_name, d.status, drift=d))

    perf = accuracy(hist, points, backtest_wape)
    results.append(perf)

    data_status = worst([r.status for r in results if r.check_kind in ("FEATURE", "STORE_SALES")])
    return MonitoringOutcome(w, results, data_status, d.status, perf.status)
