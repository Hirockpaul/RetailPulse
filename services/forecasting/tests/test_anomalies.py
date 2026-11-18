"""Unusual-sales detection (V2 step 1e-1): rules from docs/V2-PLAN.md, never looking ahead."""

import numpy as np
import pandas as pd

from app.anomalies import detect as d
from app.anomalies.evaluate import evaluate
from app.data import History, build_history
from app.synthetic.generator import generate
from tests.helpers import END


def flat_history(level: float, n_days: int = 120, n_series: int = 3, seed: int = 0) -> History:
    """Poisson sales around a flat `level`, starting on a Monday."""
    rng = np.random.default_rng(seed)
    y = rng.poisson(level, (n_series, n_days)).astype(float)
    days = np.datetime64("2026-01-05") + np.arange(n_days).astype("timedelta64[D]")  # a Monday
    return History(
        days=days,
        product_ids=[f"p{i}" for i in range(n_series)],
        location_ids=["s0"] * n_series,
        category=np.zeros(n_series, int),
        store=np.zeros(n_series, int),
        y=y,
        start_idx=np.zeros(n_series, int),
        sources={"SYNTHETIC"},
    )


def test_expected_sales_use_only_earlier_days() -> None:
    hist = flat_history(5.0)
    t = 100
    before = d.baseline(hist).expected[:, t].copy()
    changed = History(**{**hist.__dict__, "y": hist.y.copy()})
    changed.y[:, t:] = 999.0  # the day itself and everything after
    assert np.array_equal(d.baseline(changed).expected[:, t], before)


def test_too_little_history_is_not_judged() -> None:
    b = d.baseline(flat_history(5.0))
    assert not b.judged[:, : 7 * d.MIN_PAST_VALUES].any()  # fewer than 4 past same weekdays
    assert b.judged[:, 7 * d.MIN_PAST_VALUES :].all()


def test_a_clear_spike_is_found_with_high_severity_and_a_plain_explanation() -> None:
    hist = flat_history(5.0)
    hist.y[1, 110] = 60.0
    findings = [f for f in d.detect(hist) if f["kind"] == "SPIKE"]
    spike = next(f for f in findings if f["series"] == 1 and f["day"] == hist.days[110])
    assert spike["severity"] == "HIGH" and spike["observed"] == 60.0
    assert 3 <= spike["expected"] <= 7
    assert "Sold 60 units" in spike["explanation"] and "expected" in spike["explanation"]


def test_a_planned_promotion_is_a_known_cause_not_an_anomaly() -> None:
    hist = flat_history(5.0)
    promo = np.ones_like(hist.y)
    promo[0, 110] = 3.0
    hist = History(**{**hist.__dict__, "promo": promo})
    hist.y[0, 110] = 16.0  # about what a ×3 promotion should bring
    b = d.baseline(hist)
    assert 12 <= b.expected[0, 110] <= 20
    assert not d.spikes_robust_z(hist, b)[0, 110]


def test_past_promotion_days_do_not_raise_the_baseline() -> None:
    hist = flat_history(5.0)
    promo = np.ones_like(hist.y)
    promo[2, 103] = 1.6  # same weekday, one week before day 110
    hist.y[2, 103] = 400.0
    hist = History(**{**hist.__dict__, "promo": promo})
    assert d.baseline(hist).expected[2, 110] < 8


def test_three_zero_days_are_a_drop_only_where_sales_were_expected() -> None:
    busy, slow = flat_history(4.0), flat_history(0.5)
    for hist in (busy, slow):
        hist.y[0, 100:103] = 0.0
    busy_drops = d.drops(busy, d.baseline(busy))
    assert busy_drops[0, 100] and busy_drops[0].sum() == 1  # one finding per run of zero days
    assert not d.drops(slow, d.baseline(slow))[0].any()  # zeros are normal for a slow seller
    drop = next(f for f in d.detect(busy) if f["kind"] == "DROP")
    assert drop["severity"] == "MEDIUM" and drop["expected"] >= d.DROP_MIN_EXPECTED


def test_only_recent_days_are_reported() -> None:
    hist = flat_history(5.0)
    hist.y[0, 40] = 80.0  # old
    hist.y[0, 115] = 80.0  # recent
    days = {f["day"] for f in d.detect(hist, recent_days=30) if f["series"] == 0}
    assert hist.days[115] in days and hist.days[40] not in days


def test_detection_finds_most_injected_spikes_on_labelled_synthetic_data() -> None:
    cats = ["Beverages", "Dairy", "Snacks", "Household"]
    products = pd.DataFrame(
        {"product_id": [f"p{i}" for i in range(30)], "category": [cats[i % 4] for i in range(30)]}
    )
    stores = pd.DataFrame({"location_id": ["s0", "s1"]})
    data = generate(products, stores, END, days=200, seed=3, new_share=0.0, anomaly_share=0.6)
    pairs = pd.DataFrame(
        [
            (p, s, c)
            for p, c in zip(products.product_id, products.category, strict=True)
            for s in stores.location_id
        ],
        columns=["product_id", "location_id", "category_id"],
    )
    hist = build_history(pairs, data.demand, {"SYNTHETIC"}, data.promotions)
    result = evaluate(hist, data.anomalies, rule="v1")
    spikes = result["spike:robust_z"]
    assert spikes["actual"] > 5 and spikes["recall"] >= 0.6
    assert result["drop"]["recall"] >= 0.5
