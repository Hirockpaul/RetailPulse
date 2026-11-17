"""Synthetic daily sales history. ALL OF THIS DATA IS FICTIONAL.

Builds a realistic-looking but artificial demand pattern per product × store so that the
forecasting models have something to learn and be honestly measured against:

  mean units/day = category base × product popularity × store size
                   × weekday pattern × yearly season × linear trend × promotions
  units          = negative-binomial draw around that mean (over-dispersed counts)

A few products are "slow movers" and a few are "new" (short history) so the low-history
fallback is exercised. Fully deterministic for a given seed.
"""

from __future__ import annotations

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


def simulate(
    products: pd.DataFrame,
    stores: pd.DataFrame,
    end_day: date,
    days: int = 365,
    seed: int = 42,
    slow_share: float = 0.10,
    new_share: float = 0.05,
) -> dict:
    """The generator's internals: expected units `lam`, drawn `units`, and which days exist.

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
            promo[pi, si, np.minimum(starts + offset, days - 1)] *= 1.6
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

    return {"lam": lam, "units": units, "observed": observed, "dates": dates}


def generate_history(
    products: pd.DataFrame,
    stores: pd.DataFrame,
    end_day: date,
    days: int = 365,
    seed: int = 42,
    slow_share: float = 0.10,
    new_share: float = 0.05,
) -> pd.DataFrame:
    """Return rows (product_id, location_id, day, units) for `days` days ending on `end_day`.

    `products` needs columns product_id and category; `stores` needs location_id.
    Days before a "new" product's launch are simply absent (not zero).
    """
    sim = simulate(products, stores, end_day, days, seed, slow_share, new_share)
    units, observed, dates = sim["units"], sim["observed"], sim["dates"]
    pidx, sidx, tidx = np.nonzero(observed)
    return pd.DataFrame(
        {
            "product_id": products["product_id"].to_numpy()[pidx],
            "location_id": stores["location_id"].to_numpy()[sidx],
            "day": dates.date[tidx],
            "units": units[pidx, sidx, tidx].astype(int),
        }
    )
