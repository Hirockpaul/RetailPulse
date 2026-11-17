"""Forecast accuracy metrics. WAPE is the main one: sum |error| / sum actual.

Also: bias (does the model systematically over- or under-forecast?) and, for a forecast range,
coverage (how often the actual value fell inside it) and mean width.
"""

from __future__ import annotations

import numpy as np


def mae(actual: np.ndarray, predicted: np.ndarray) -> float:
    return float(np.mean(np.abs(predicted - actual))) if actual.size else float("nan")


def rmse(actual: np.ndarray, predicted: np.ndarray) -> float:
    return float(np.sqrt(np.mean((predicted - actual) ** 2))) if actual.size else float("nan")


def wape(actual: np.ndarray, predicted: np.ndarray) -> float:
    """Weighted absolute percentage error as a fraction (0.25 = 25%). NaN if nothing was sold."""
    total = float(np.sum(actual))
    return float(np.sum(np.abs(predicted - actual)) / total) if total > 0 else float("nan")


def bias(actual: np.ndarray, predicted: np.ndarray) -> float:
    """sum(forecast - actual) / sum(actual) as a fraction: +0.05 = 5 % over-forecast,
    -0.05 = 5 % under-forecast. NaN if nothing was sold."""
    total = float(np.sum(actual))
    return float(np.sum(predicted - actual) / total) if total > 0 else float("nan")


def interval_coverage(actual: np.ndarray, lower: np.ndarray, upper: np.ndarray) -> float:
    """Share of actual values inside [lower, upper] (bounds included)."""
    if not actual.size:
        return float("nan")
    return float(np.mean((actual >= lower) & (actual <= upper)))


def interval_width(lower: np.ndarray, upper: np.ndarray) -> float:
    """Mean width of the range, in units."""
    return float(np.mean(upper - lower)) if lower.size else float("nan")
