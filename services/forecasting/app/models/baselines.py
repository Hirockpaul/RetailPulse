"""Transparent baseline forecasts. All functions use only data up to and including `origin`."""

from __future__ import annotations

import warnings

import numpy as np


def moving_average(y: np.ndarray, origin: int, horizon: int, window: int = 28) -> np.ndarray:
    """Flat forecast: the mean of the last `window` observed days. y is (series x days)."""
    segment = y[:, max(0, origin - window + 1) : origin + 1]
    with warnings.catch_warnings():  # a series with no data yet has an all-NaN window
        warnings.simplefilter("ignore", RuntimeWarning)
        mean = np.nanmean(segment, axis=1)
    mean = np.nan_to_num(mean, nan=0.0)
    return np.repeat(mean[:, None], horizon, axis=1)


def seasonal_naive(y: np.ndarray, origin: int, horizon: int, period: int = 7) -> np.ndarray:
    """Each target day gets the value of the most recent same weekday that is already known."""
    out = np.zeros((y.shape[0], horizon))
    for h in range(1, horizon + 1):
        steps_back = period * -(-h // period)  # ceil(h / period) whole weeks
        out[:, h - 1] = y[:, origin + h - steps_back]
    return np.nan_to_num(out, nan=0.0)
