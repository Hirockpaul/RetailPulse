from datetime import date

import numpy as np
import pandas as pd

from app.synthetic.generator import generate_history

END = date(2026, 6, 30)


def catalog(n_products: int = 30, n_stores: int = 3) -> tuple[pd.DataFrame, pd.DataFrame]:
    cats = ["Beverages", "Dairy", "Snacks", "Household"]
    products = pd.DataFrame(
        {
            "product_id": [f"p{i}" for i in range(n_products)],
            "category": [cats[i % 4] for i in range(n_products)],
        }
    )
    stores = pd.DataFrame({"location_id": [f"s{i}" for i in range(n_stores)]})
    return products, stores


def test_is_deterministic_for_a_seed_and_differs_across_seeds() -> None:
    products, stores = catalog()
    a = generate_history(products, stores, END, days=120, seed=7)
    b = generate_history(products, stores, END, days=120, seed=7)
    c = generate_history(products, stores, END, days=120, seed=8)
    pd.testing.assert_frame_equal(a, b)
    assert not a["units"].equals(c["units"])


def test_shape_dates_and_non_negative_integers() -> None:
    products, stores = catalog()
    df = generate_history(products, stores, END, days=100, seed=1, new_share=0.0)
    assert len(df) == 30 * 3 * 100
    assert df["day"].max() == END
    assert (df["units"] >= 0).all()
    assert pd.api.types.is_integer_dtype(df["units"])
    assert df.duplicated(["product_id", "location_id", "day"]).sum() == 0


def test_weekends_sell_more_than_mondays() -> None:
    products, stores = catalog(60)
    df = generate_history(products, stores, END, days=364, seed=3, new_share=0.0)
    weekday = pd.to_datetime(df["day"]).dt.day_of_week
    saturday, monday = df[weekday == 5]["units"].mean(), df[weekday == 0]["units"].mean()
    assert saturday > monday * 1.3


def test_new_products_have_short_history_and_nothing_before_launch() -> None:
    products, stores = catalog(60)
    df = generate_history(products, stores, END, days=200, seed=5, new_share=0.2)
    per_series = df.groupby(["product_id", "location_id"])["day"].agg(["min", "max", "count"])
    short = per_series[per_series["count"] < 100]
    assert 0 < len(short) < len(per_series)
    assert (short["count"] <= 45).all()
    assert (per_series["max"] == END).all()  # every series runs up to the end date


def test_categories_differ_in_volume() -> None:
    products, stores = catalog(60)
    df = generate_history(products, stores, END, days=200, seed=9, new_share=0.0)
    cat = products.set_index("product_id")["category"]
    by_cat = df.assign(category=df["product_id"].map(cat)).groupby("category")["units"].mean()
    assert by_cat["Beverages"] > by_cat["Household"] * 1.5


def test_rejects_non_positive_days() -> None:
    products, stores = catalog(3)
    try:
        generate_history(products, stores, END, days=0)
    except ValueError:
        return
    raise AssertionError("expected ValueError")


def test_values_are_plausible_counts() -> None:
    products, stores = catalog()
    df = generate_history(products, stores, END, days=200, seed=2)
    assert 0.5 < np.mean(df["units"]) < 15


def test_simulate_exposes_the_true_expected_demand_behind_the_draws() -> None:
    from app.synthetic.generator import simulate

    products, stores = catalog(20)
    sim = simulate(products, stores, END, days=120, seed=4, new_share=0.0)
    df = generate_history(products, stores, END, days=120, seed=4, new_share=0.0)
    assert sim["units"].sum() == df["units"].sum()  # same draws
    # Observed demand averages out to the expected demand (law of large numbers)
    assert abs(sim["units"].mean() / sim["lam"].mean() - 1) < 0.03


# ---------------------------------------------------------------- V2 step 1a


def test_promotion_calendar_matches_the_boosted_days() -> None:
    from app.synthetic.generator import PROMO_UPLIFT, generate, simulate

    products, stores = catalog(20)
    sim = simulate(products, stores, END, days=120, seed=4, new_share=0.0)
    data = generate(products, stores, END, days=120, seed=4, new_share=0.0)
    assert len(data.promotions) == int((sim["promo"] > 1).sum()) > 0
    assert (data.promotions["uplift"] >= PROMO_UPLIFT - 1e-9).all()
    assert data.anomalies.empty  # nothing is injected unless asked


def test_injected_anomalies_are_labelled_and_leave_every_other_day_unchanged() -> None:
    from app.synthetic.generator import DROP_DAYS, generate

    products, stores = catalog(40)
    clean = generate(products, stores, END, days=150, seed=6, new_share=0.0)
    dirty = generate(products, stores, END, days=150, seed=6, new_share=0.0, anomaly_share=0.5)
    labels = dirty.anomalies
    assert {"SPIKE", "DROP"} <= set(labels["kind"])

    key = ["product_id", "location_id", "day"]
    merged = clean.demand.merge(dirty.demand, on=key, suffixes=("_clean", "_dirty"))
    changed = merged[merged.units_clean != merged.units_dirty]
    labelled = changed.merge(labels, on=key, how="left")
    assert labelled["kind"].notna().all()  # every changed day is labelled
    assert len(merged) == len(clean.demand)

    with_units = labels.merge(dirty.demand, on=key)
    assert (with_units.actual_units == with_units.units).all()  # labels match the written history
    spikes = labels[labels.kind == "SPIKE"]
    assert (spikes.actual_units >= spikes.expected_units + 5 - 1e-9).all()
    drops = labels[labels.kind == "DROP"]
    assert (drops.actual_units == 0).all() and len(drops) % DROP_DAYS == 0
    assert (drops.expected_units >= 2).all()
    promo_days = labels.merge(dirty.promotions, on=key)
    assert promo_days.empty  # never on a promotion day (a promotion is not an anomaly)
