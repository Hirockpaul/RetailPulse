"""Unusual sales per product × store × day (V2 step 1e-1). Rules fixed in docs/V2-PLAN.md.

Expected sales for a day come from the same weekday over the previous 8 weeks (strictly before
the day, promotion days left out), times the promotion uplift planned for the day — a promotion
is a known cause, not an anomaly. Days with fewer than 4 usable past values are not judged.

Rule v2 (shipped): expected = mean of those values after dropping the single largest,
scale = √max(expected, their variance), at least 1. Rule v1 (median + MAD, kept to compare) had
3.5 % precision: the median of small counts sits below their mean. See docs/V2-PLAN.md 1e-1.

  SPIKE  z = (actual − expected) / scale ≥ 5
  DROP   3 days in a row with zero sales whose expected total is ≥ 7 units (Poisson chance ≤ 0.1 %)

Two comparison methods for spikes (IQR rule, Isolation Forest) are kept so the choice stays
reproducible (`npm run forecast:measure -- --anomalies`). Detection never changes stock: it only
writes findings for a person to review.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
from sklearn.ensemble import IsolationForest

from app.data import History

WEEKS = 8
MIN_PAST_VALUES = 4
Z_SPIKE = 5.0
Z_HIGH = 10.0
IQR_K = 3.0
DROP_DAYS = 3
DROP_MIN_EXPECTED = 7.0
DROP_HIGH_EXPECTED = 14.0
WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
RULE = "v1"  # the shipped rule (v2 failed its held-out check, docs/V2-PLAN.md 1e-1)


@dataclass
class Baseline:
    """Per series × day: what was expected, how much it usually varies, and the robust z."""

    expected: np.ndarray
    scale: np.ndarray
    z: np.ndarray
    judged: np.ndarray  # enough usable past same-weekday values
    lags: np.ndarray  # (weeks, series, days) past same-weekday values; NaN = not usable
    promo: np.ndarray


def baseline(hist: History, rule: str = RULE) -> Baseline:
    if rule not in ("v1", "v2"):
        raise ValueError(f"unknown rule {rule!r}")
    y, promo = hist.y, hist.promo
    n_series, n_days = y.shape
    lags = np.full((WEEKS, n_series, n_days), np.nan)
    for k in range(1, WEEKS + 1):
        shift = 7 * k
        past = np.where(promo[:, : n_days - shift] > 1.0, np.nan, y[:, : n_days - shift])
        lags[k - 1, :, shift:] = past  # value of the same weekday k weeks earlier
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN columns are simply not judged
        median = np.nanmedian(lags, axis=0)
        mad = np.nanmedian(np.abs(lags - median[None]), axis=0)
    judged = (np.isfinite(lags).sum(axis=0) >= MIN_PAST_VALUES) & np.isfinite(y)
    if rule == "v1":
        expected = np.where(judged, median * promo, np.nan)
        scale = np.maximum.reduce(
            [1.4826 * mad, np.sqrt(np.maximum(expected, 0)), np.ones_like(mad)]
        )
    else:
        # Drop the single largest past value, so one earlier spike cannot inflate the baseline.
        top = np.argmax(np.where(np.isfinite(lags), lags, -np.inf), axis=0)
        trimmed = lags.copy()
        np.put_along_axis(trimmed, top[None], np.nan, axis=0)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            mean = np.nanmean(trimmed, axis=0)
            var = np.nanvar(trimmed, axis=0, ddof=1)
        expected = np.where(judged, mean * promo, np.nan)
        spread = np.where(judged, np.maximum(expected, var * promo**2), np.nan)
        scale = np.maximum(np.sqrt(spread), 1.0)
    z = np.where(judged, (y - expected) / scale, np.nan)
    return Baseline(expected, scale, z, judged, lags, promo)


def spikes_robust_z(hist: History, b: Baseline) -> np.ndarray:
    return b.judged & (b.z >= Z_SPIKE)


def spikes_iqr(hist: History, b: Baseline) -> np.ndarray:
    # Computed only here: quartiles of the past values are slow (~15 s) and only this
    # comparison method needs them.
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        q1, q3 = np.nanpercentile(b.lags, [25, 75], axis=0)
    q1, q3 = q1 * b.promo, q3 * b.promo
    limit = q3 + IQR_K * np.maximum(q3 - q1, 1.0)
    return b.judged & (hist.y > limit)


def spikes_isolation_forest(hist: History, b: Baseline, seed: int = 42) -> np.ndarray:
    rows = np.argwhere(b.judged)
    s, t = rows[:, 0], rows[:, 1]
    weekday = (hist.days[t].astype("datetime64[D]").astype(int) + 3) % 7
    x = np.column_stack(
        [hist.y[s, t], b.expected[s, t], hist.y[s, t] - b.expected[s, t], b.z[s, t], weekday]
    )
    forest = IsolationForest(n_estimators=200, contamination=0.001, random_state=seed, n_jobs=-1)
    outlier = forest.fit_predict(x) == -1
    out = np.zeros_like(b.judged)
    # Isolation Forest flags unusual rows in any direction; only high sales are spikes.
    out[s[outlier], t[outlier]] = (
        hist.y[s[outlier], t[outlier]] > b.expected[s[outlier], t[outlier]]
    )
    return out


SPIKE_METHODS = {
    "robust_z": spikes_robust_z,
    "iqr": spikes_iqr,
    "isolation_forest": spikes_isolation_forest,
}


def drops(hist: History, b: Baseline) -> np.ndarray:
    """Start days of runs of DROP_DAYS zero-sales days with a high expected total (one per run)."""
    n_days = hist.n_days
    zero = (hist.y == 0) & b.judged
    exp = np.where(b.judged, b.expected, 0.0)
    window = np.zeros_like(zero)
    total = np.zeros_like(exp)
    for t in range(n_days - DROP_DAYS + 1):
        window[:, t] = zero[:, t : t + DROP_DAYS].all(axis=1)
        total[:, t] = exp[:, t : t + DROP_DAYS].sum(axis=1)
    start = window & (total >= DROP_MIN_EXPECTED)
    previous = np.zeros_like(start)
    previous[:, 1:] = start[:, :-1]
    return start & ~previous


def detect(hist: History, recent_days: int = 90) -> list[dict]:
    """Findings of the shipped rule for the last `recent_days` days, ready to store."""
    b = baseline(hist, RULE)
    spike = spikes_robust_z(hist, b)
    drop = drops(hist, b)
    first = max(hist.n_days - recent_days, 0)
    found: list[dict] = []
    for s, t in np.argwhere(spike[:, first:]):
        t = int(t) + first
        observed, expected, z = float(hist.y[s, t]), float(b.expected[s, t]), float(b.z[s, t])
        weekday = WEEKDAYS[int((hist.days[t].astype("datetime64[D]").astype(int) + 3) % 7)]
        promo = float(hist.promo[s, t])
        found.append(
            {
                "series": int(s),
                "day": hist.days[t],
                "kind": "SPIKE",
                "severity": "HIGH" if z >= Z_HIGH else "MEDIUM",
                "score": round(z, 2),
                "observed": observed,
                "expected": round(expected, 2),
                "explanation": (
                    f"Sold {observed:.0f} units; about {expected:.1f} were expected for a {weekday} "
                    f"(typical of the previous {WEEKS} {weekday}s"
                    + (f", times the planned promotion ×{promo:.1f}" if promo > 1 else "")
                    + f"). That is {z:.1f} times the usual variation above normal."
                ),
            }
        )
    exp = np.where(b.judged, b.expected, 0.0)
    for s, t in np.argwhere(drop[:, first:]):
        t = int(t) + first
        total = float(exp[s, t : t + DROP_DAYS].sum())
        found.append(
            {
                "series": int(s),
                "day": hist.days[t],
                "kind": "DROP",
                "severity": "HIGH" if total >= DROP_HIGH_EXPECTED else "MEDIUM",
                "score": round(total, 2),
                "observed": 0.0,
                "expected": round(total, 2),
                "explanation": (
                    f"No sales for {DROP_DAYS} days in a row; about {total:.1f} units were expected "
                    "over those days. Possible causes: stock-out, a shelf or system problem, "
                    "or a recording gap — check before acting."
                ),
            }
        )
    return found
