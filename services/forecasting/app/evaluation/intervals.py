"""Forecast ranges from measured errors (split conformal, by forecast level).

Why not "forecast ± 1.28 × σ"? Daily sales are small, skewed counts. A symmetric normal band is
too wide for slow sellers and too narrow for fast ones (measured in V2 step 1b: 91 % vs 78 %
coverage for a nominal 80 %). Instead:

  1. Take forecasts made for a CALIBRATION window (data the model was not trained on) and the
     errors they really had: residual = actual − forecast.
  2. Group the residuals by how big the forecast was (LEVEL_EDGES, units/day), because the error
     spread grows with the level.
  3. For an 80 % range use the 10th and 90th percentile of the residuals in that group; for 95 %
     the 2.5th and 97.5th. range = [forecast + low quantile, forecast + high quantile], at least 0.

Calibrated on the validation window, the ranges are then CHECKED on the untouched test window
(coverage = share of actual values inside). For live forecasts the quantiles come from both
windows. The ranges are only as good as that check: they assume the next weeks behave like the
calibration weeks, and days 8-14 of a forecast use the same quantiles as days 1-7 (only 1-7 are
scored).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

LEVEL_EDGES = (0.0, 0.5, 1.0, 2.0, 4.0, 8.0, float("inf"))
LEVELS: dict[int, tuple[float, float]] = {80: (0.10, 0.90), 95: (0.025, 0.975)}
MIN_POINTS = 200  # a level group with fewer calibration points uses all residuals instead


@dataclass
class Calibration:
    """Residual quantiles per forecast-level group, for each range level (80, 95)."""

    edges: tuple[float, ...]
    low: dict[int, np.ndarray]  # level -> quantile per group (added to the forecast)
    high: dict[int, np.ndarray]
    n_points: np.ndarray  # calibration points per group
    pooled: np.ndarray  # True where the group had too few points and used all residuals

    def group_of(self, forecast: np.ndarray) -> np.ndarray:
        """Index of the level group of every forecast value."""
        return np.clip(
            np.searchsorted(self.edges, forecast, side="right") - 1, 0, len(self.edges) - 2
        )


def calibrate(
    forecast: np.ndarray,
    actual: np.ndarray,
    mask: np.ndarray,
    edges: tuple[float, ...] = LEVEL_EDGES,
) -> Calibration:
    """Learn the residual quantiles from forecasts whose actual values are known (`mask`)."""
    f, r = forecast[mask], (actual - forecast)[mask]
    if f.size == 0:
        raise ValueError("No calibration points: cannot build forecast ranges.")
    n_groups = len(edges) - 1
    groups = np.clip(np.searchsorted(edges, f, side="right") - 1, 0, n_groups - 1)
    n_points = np.bincount(groups, minlength=n_groups)
    pooled = n_points < MIN_POINTS
    low: dict[int, np.ndarray] = {}
    high: dict[int, np.ndarray] = {}
    for level, (q_low, q_high) in LEVELS.items():
        lo, hi = np.empty(n_groups), np.empty(n_groups)
        for g in range(n_groups):
            res = r if pooled[g] else r[groups == g]
            # "lower"/"higher" never interpolate inwards, so the range is not made narrower.
            lo[g] = np.quantile(res, q_low, method="lower")
            hi[g] = np.quantile(res, q_high, method="higher")
        low[level], high[level] = lo, hi
    return Calibration(tuple(edges), low, high, n_points, pooled)


def apply(cal: Calibration, forecast: np.ndarray, level: int) -> tuple[np.ndarray, np.ndarray]:
    """(lower, upper) range around `forecast` at `level` percent; never below zero, and always
    containing the forecast itself (this can only widen a range, never narrow it)."""
    g = cal.group_of(forecast)
    lower = np.minimum(np.clip(forecast + cal.low[level][g], 0.0, None), forecast)
    upper = np.maximum(forecast + cal.high[level][g], forecast)
    return lower, upper


def coverage_by_group(
    cal: Calibration, forecast: np.ndarray, actual: np.ndarray, mask: np.ndarray, level: int
) -> tuple[np.ndarray, np.ndarray]:
    """Per level group: share of actual values inside the range, and how many points were checked."""
    lower, upper = apply(cal, forecast, level)
    inside = (actual >= lower) & (actual <= upper)
    g = cal.group_of(forecast)[mask]
    n = np.bincount(g, minlength=len(cal.edges) - 1)
    hits = np.bincount(g, weights=inside[mask].astype(float), minlength=len(cal.edges) - 1)
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(n > 0, hits / n, np.nan), n


def normal_band(forecast: np.ndarray, sigma: np.ndarray, z: float) -> tuple[np.ndarray, np.ndarray]:
    """The Day-6 range (forecast ± z·σ per series), kept only to compare against."""
    return np.clip(forecast - z * sigma[:, None], 0.0, None), forecast + z * sigma[:, None]
