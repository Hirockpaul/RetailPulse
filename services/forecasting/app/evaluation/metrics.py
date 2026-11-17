"""Forecast accuracy metrics. WAPE is the main one: sum |error| / sum actual."""

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
