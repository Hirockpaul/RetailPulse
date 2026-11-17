"""Synthetic daily sales history. ALL OF THIS DATA IS FICTIONAL.

Builds a realistic-looking but artificial demand pattern per product × store so that the
forecasting models have something to learn and be honestly measured against:

  mean units/day = category base × product popularity × store size
                   × weekday pattern × yearly season × linear trend × promotions
  units          = negative-binomial draw around that mean (over-dispersed counts)

A few products are "slow movers" and a few are "new" (short history) so the low-history
fallback is exercised. Fully deterministic for a given seed.

V2 (step 1a) also returns what used to stay hidden, so evaluation can be honest:
  * the promotion calendar (which days were boosted, and by how much);
  * optional INJECTED anomalies — sales spikes and sudden drops to zero — with ground-truth
    labels. They use a separate random stream, so every other day keeps exactly the value it
    would have without injection.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

import numpy as np
import pandas as pd

# Average units per day for a typical product of the category in an average store.
CATEGORY_BASE = {
    "Beverages": 5.0,
    "Snacks": 3.5,
    "Dairy": 4.0,
    "Bakery": 3.0,
    "Household": 1.5,
    "Personal Care": 1.2,
    "Frozen": 2.0,
    "Produce": 4.5,
}
# Strength of the yearly season (peaks in summer for positive values).
CATEGORY_SEASON = {"Beverages": 0.25, "Frozen": 0.20, "Produce": 0.10, "Dairy": 0.03}
# Monday..Sunday multipliers: busier Friday/Saturday.
WEEKDAY = np.array([0.85, 0.85, 0.90, 0.95, 1.15, 1.35, 1.00])
DISPERSION = 8.0  # negative-binomial size; larger = closer to Poisson
PROMO_UPLIFT = 1.6  # demand multiplier on a promotion day (overlapping promotions multiply)

# Injected anomalies (labelled ground truth for anomaly detection).
ANOMALY_SHARE = 0.12  # default share of series that get one anomaly (CLI); 0 in library calls
SPIKE_SHARE = 0.7  # the rest are drops
SPIKE_FACTOR = (4.0, 7.0)  # spike = this many times the expected demand (at least +5 units)
DROP_DAYS = 3  # a drop = this many consecutive days with zero sales
MIN_DROP_MEAN = 2.0  # drops only where ≥ 2 units/day were expected, so zero is clearly unusual


@dataclass
class SyntheticData:
    """Everything the generator produces, as rows ready to load."""

    demand: pd.DataFrame  # product_id, location_id, day, units
    promotions: pd.DataFrame  # product_id, location_id, day, uplift
    anomalies: pd.DataFrame  # product_id, location_id, day, kind, expected_units, actual_units


def simulate(
    products: pd.DataFrame,
    stores: pd.DataFrame,
    end_day: date,
    days: int = 365,
    seed: int = 42,
    slow_share: float = 0.10,
    new_share: float = 0.05,
    anomaly_share: float = 0.0,
) -> dict:
    """The generator's internals: expected units `lam`, drawn `units`, which days exist, the
    promotion multipliers `promo`, and the injected `anomalies` (p, s, t, kind, expected, actual).

    All arrays are (products, stores, days). Exposed so tests and diagnostics can compare a
    forecast with the TRUE expected demand (the noise floor no model can beat).
    """
    if days < 1:
        raise ValueError("days must be at least 1")
    rng = np.random.default_rng(seed)
    n_p, n_s = len(products), len(stores)

    popularity = np.clip(rng.lognormal(0.0, 0.6, n_p), 0.15, 4.0)
    popularity[rng.random(n_p) < slow_share] *= 0.25
    store_size = rng.lognormal(0.0, 0.25, n_s)
    base = products["category"].map(CATEGORY_BASE).fillna(2.0).to_numpy()
    mean = base[:, None] * popularity[:, None] * store_size[None, :]  # (P, S)

    growth = rng.uniform(-0.15, 0.25, (n_p, n_s))  # change over a year
    season = products["category"].map(CATEGORY_SEASON).fillna(0.05).to_numpy()

    dates = pd.date_range(end=pd.Timestamp(end_day), periods=days)
    t = np.arange(days)
    weekly = WEEKDAY[dates.day_of_week.to_numpy()]
    yearly = 1.0 + season[:, None] * np.sin(2 * np.pi * (dates.day_of_year.to_numpy() - 80) / 365.0)
    trend = 1.0 + growth[:, :, None] * (t[None, None, :] / 365.0)
    lam = mean[:, :, None] * weekly[None, None, :] * yearly[:, None, :] * trend

    # Promotions: a few short boosts per series that no model can know about.
    promo = np.ones_like(lam)
    pi = np.arange(n_p)[:, None]
    si = np.arange(n_s)[None, :]
    for _ in range(3):
        starts = rng.integers(0, max(days - 4, 1), (n_p, n_s))
        for offset in range(4):
            promo[pi, si, np.minimum(starts + offset, days - 1)] *= PROMO_UPLIFT
    lam *= promo

    p = DISPERSION / (DISPERSION + lam)
    units = rng.negative_binomial(DISPERSION, p)

    # New products: only the last 20-45 days exist.
    history_len = np.full(n_p, days)
    is_new = rng.random(n_p) < new_share
    history_len[is_new] = rng.integers(20, 46, int(is_new.sum()))
    history_len = np.minimum(history_len, days)
    observed = t[None, None, :] >= (days - history_len)[:, None, None]
    observed = np.broadcast_to(observed, units.shape)

    anomalies: list[tuple[int, int, int, str, float, int]] = []
    if anomaly_share > 0:
        units, anomalies = inject_anomalies(
            lam, units, observed, promo, np.random.default_rng([seed, 1001]), anomaly_share
        )
    return {
        "lam": lam,
        "units": units,
        "observed": observed,
        "dates": dates,
        "promo": promo,
        "anomalies": anomalies,
    }


def inject_anomalies(
    lam: np.ndarray,
    units: np.ndarray,
    observed: np.ndarray,
    promo: np.ndarray,
    rng: np.random.Generator,
    share: float,
) -> tuple[np.ndarray, list[tuple[int, int, int, str, float, int]]]:
    """Give a `share` of series one anomaly on non-promotion days and return the labels.

    SPIKE: one day at 4-7x the expected demand (at least 5 units above it).
    DROP:  DROP_DAYS consecutive days of zero sales where >= MIN_DROP_MEAN units/day were expected.
    """
    units = units.copy()
    labels: list[tuple[int, int, int, str, float, int]] = []
    chosen = rng.random(units.shape[:2]) < share
    for p, s in zip(*np.nonzero(chosen), strict=True):
        normal = observed[p, s] & (promo[p, s] == 1.0)
        if rng.random() < SPIKE_SHARE:
            days = np.flatnonzero(normal)
            if len(days) == 0:
                continue
            t = int(rng.choice(days))
            expected = float(lam[p, s, t])
            actual = int(max(round(expected * rng.uniform(*SPIKE_FACTOR)), np.ceil(expected) + 5))
            units[p, s, t] = actual
            labels.append((int(p), int(s), t, "SPIKE", expected, actual))
        else:
            ok = normal & (lam[p, s] >= MIN_DROP_MEAN)
            window = np.lib.stride_tricks.sliding_window_view(ok, DROP_DAYS).all(axis=1)
            starts = np.flatnonzero(window)
            if len(starts) == 0:
                continue
            t0 = int(rng.choice(starts))
            for t in range(t0, t0 + DROP_DAYS):
                units[p, s, t] = 0
                labels.append((int(p), int(s), t, "DROP", float(lam[p, s, t]), 0))
    return units, labels


def generate(
    products: pd.DataFrame,
    stores: pd.DataFrame,
    end_day: date,
    days: int = 365,
    seed: int = 42,
    slow_share: float = 0.10,
    new_share: float = 0.05,
    anomaly_share: float = 0.0,
) -> SyntheticData:
    """Demand rows plus the promotion calendar and the anomaly labels, for `days` days ending on
    `end_day`. `products` needs product_id and category; `stores` needs location_id.
    Days before a "new" product's launch are simply absent (not zero)."""
    sim = simulate(products, stores, end_day, days, seed, slow_share, new_share, anomaly_share)
    units, observed, dates, promo = sim["units"], sim["observed"], sim["dates"], sim["promo"]
    pid = products["product_id"].to_numpy()
    sid = stores["location_id"].to_numpy()

    pidx, sidx, tidx = np.nonzero(observed)
    demand = pd.DataFrame(
        {
            "product_id": pid[pidx],
            "location_id": sid[sidx],
            "day": dates.date[tidx],
            "units": units[pidx, sidx, tidx].astype(int),
        }
    )
    pidx, sidx, tidx = np.nonzero(observed & (promo > 1.0))
    promotions = pd.DataFrame(
        {
            "product_id": pid[pidx],
            "location_id": sid[sidx],
            "day": dates.date[tidx],
            "uplift": np.round(promo[pidx, sidx, tidx], 3),
        }
    )
    anomalies = pd.DataFrame(
        [
            (pid[p], sid[s], dates.date[t], kind, round(expected, 4), actual)
            for p, s, t, kind, expected, actual in sim["anomalies"]
        ],
        columns=["product_id", "location_id", "day", "kind", "expected_units", "actual_units"],
    )
    return SyntheticData(demand, promotions, anomalies)


def generate_history(
    products: pd.DataFrame,
    stores: pd.DataFrame,
    end_day: date,
    days: int = 365,
    seed: int = 42,
    slow_share: float = 0.10,
    new_share: float = 0.05,
) -> pd.DataFrame:
    """Only the demand rows (product_id, location_id, day, units), without injected anomalies."""
    return generate(products, stores, end_day, days, seed, slow_share, new_share).demand
