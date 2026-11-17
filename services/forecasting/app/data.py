"""Loading demand history into a (series x days) matrix."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
import psycopg


@dataclass
class History:
    """Daily units per series (product x store). NaN means "before this series' first day"."""

    days: np.ndarray  # datetime64[D], one per column
    product_ids: list[str]
    location_ids: list[str]
    category: np.ndarray  # int code per series
    store: np.ndarray  # int code per series
    y: np.ndarray  # (series, days)
    start_idx: np.ndarray  # first observed day index per series (n_days if never observed)
    sources: set[str]
    # Promotion uplift per series and day (1.0 = no promotion). Promotions are planned in advance,
    # so the model may know them for the day it predicts.
    promo: np.ndarray | None = None

    def __post_init__(self) -> None:
        if self.promo is None:
            self.promo = np.ones_like(self.y)

    @property
    def n_days(self) -> int:
        return int(self.y.shape[1])

    @property
    def n_series(self) -> int:
        return int(self.y.shape[0])

    @property
    def history_days(self) -> np.ndarray:
        return self.n_days - self.start_idx


def build_history(
    pairs: pd.DataFrame,
    demand: pd.DataFrame,
    sources: set[str] | None = None,
    promotions: pd.DataFrame | None = None,
) -> History:
    """pairs: product_id, location_id, category_id for every product x store.
    demand: product_id, location_id, day, units. Days between a series' first row and the end
    that have no row are zero sales. promotions (optional): product_id, location_id, day, uplift."""
    if demand.empty:
        raise ValueError("There is no demand history yet. Run `npm run forecast:history`.")
    pairs = pairs.reset_index(drop=True)
    index = {
        (p, loc): i
        for i, (p, loc) in enumerate(zip(pairs.product_id, pairs.location_id, strict=True))
    }

    demand = demand.copy()
    demand["series"] = [
        index.get((p, loc), -1)
        for p, loc in zip(demand.product_id, demand.location_id, strict=True)
    ]
    demand = demand[demand.series >= 0]
    if demand.empty:
        raise ValueError("Demand history does not match any active product at any store.")

    days = pd.to_datetime(demand["day"])
    first_day = days.min()
    n_days = int((days.max() - first_day).days) + 1
    offsets = (days - first_day).dt.days.to_numpy()

    y = np.full((len(pairs), n_days), np.nan)
    y[demand.series.to_numpy(), offsets] = demand.units.to_numpy(dtype=float)

    start_idx = np.full(len(pairs), n_days)
    np.minimum.at(start_idx, demand.series.to_numpy(), offsets)
    after_start = np.arange(n_days)[None, :] >= start_idx[:, None]
    y[after_start & np.isnan(y)] = 0.0  # a day with no sales row after launch means 0 units

    promo = np.ones_like(y)
    if promotions is not None and not promotions.empty:
        series = np.array(
            [
                index.get((p, loc), -1)
                for p, loc in zip(promotions.product_id, promotions.location_id, strict=True)
            ]
        )
        offset = (pd.to_datetime(promotions["day"]) - first_day).dt.days.to_numpy()
        ok = (series >= 0) & (offset >= 0) & (offset < n_days)
        promo[series[ok], offset[ok]] = promotions["uplift"].to_numpy(dtype=float)[ok]

    return History(
        days=(first_day.to_datetime64() + np.arange(n_days).astype("timedelta64[D]")).astype(
            "datetime64[D]"
        ),
        product_ids=pairs.product_id.tolist(),
        location_ids=pairs.location_id.tolist(),
        category=pd.factorize(pairs.category_id)[0],
        store=pd.factorize(pairs.location_id)[0],
        y=y,
        start_idx=start_idx,
        sources=sources or set(),
        promo=promo,
    )


def load_history(conn: psycopg.Connection) -> History:
    pairs = pd.DataFrame(
        conn.execute(
            """SELECT p.id::text, l.id::text, p.category_id::text
                 FROM products p CROSS JOIN locations l
                WHERE p.is_active AND l.type = 'STORE' ORDER BY p.sku, l.code"""
        ).fetchall(),
        columns=["product_id", "location_id", "category_id"],
    )
    rows = conn.execute(
        "SELECT product_id::text, location_id::text, day, units, source FROM forecast.demand_daily"
    ).fetchall()
    demand = pd.DataFrame(rows, columns=["product_id", "location_id", "day", "units", "source"])
    sources = set(demand["source"].unique()) if not demand.empty else set()
    promotions = pd.DataFrame(
        conn.execute(
            "SELECT product_id::text, location_id::text, day, uplift FROM forecast.promotions"
        ).fetchall(),
        columns=["product_id", "location_id", "day", "uplift"],
    )
    return build_history(
        pairs, demand[["product_id", "location_id", "day", "units"]], sources, promotions
    )
