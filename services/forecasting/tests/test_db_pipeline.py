"""The whole service against a real PostgreSQL built from the API migrations."""

from __future__ import annotations

import time
from datetime import UTC, datetime, timedelta

import psycopg
import pytest

from app import pipeline, repository
from app.db import connect
from app.synthetic.generator import generate
from app.synthetic.load import read_catalog, replace_synthetic

TABLES_THAT_MUST_NOT_CHANGE = [
    "inventory_ledger",
    "inventory_balances",
    "stock_transfers",
    "stock_transfer_lines",
    "purchase_orders",
    "purchase_order_lines",
    "replenishment_recommendations",
    "sales_orders",
    "reservations",
    "outbox_events",
    "alerts",
]


def counts(url: str) -> dict[str, int]:
    with psycopg.connect(url) as conn:
        return {
            t: conn.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
            for t in TABLES_THAT_MUST_NOT_CHANGE
        }


def load_history(url: str, days: int = 190, new_share: float = 0.1) -> int:
    yesterday = (datetime.now(UTC) - timedelta(days=1)).date()
    with connect() as conn:
        products, stores = read_catalog(conn)
        data = generate(
            products, stores, yesterday, days=days, seed=4, new_share=new_share, anomaly_share=0.3
        )
        return replace_synthetic(conn, data.demand, data.promotions, data.anomalies)


def new_run(horizon: int = 7) -> str:
    with connect() as conn:
        return repository.start_run(conn, horizon)


def test_a_run_persists_forecasts_metrics_and_model_versions(catalog: dict) -> None:
    url = catalog["url"]
    rows = load_history(url)
    assert rows > 0
    run_id = new_run(horizon=7)
    pipeline.run_forecast(run_id, 7)

    with psycopg.connect(url) as conn:
        run = conn.execute(
            """SELECT status::text, data_label, series_count, fallback_count, selection_reason,
                      served_model_version_id IS NOT NULL, feature_set, history_end, finished_at
                 FROM forecast.runs WHERE id = %s""",
            (run_id,),
        ).fetchone()
        assert run[0] == "SUCCEEDED" and run[1] == "SYNTHETIC"
        assert (
            run[2] == 24 * 3 and 0 < run[3] < run[2]
        )  # some short-history series use the fallback
        assert run[4] and run[5] and len(run[6]) >= 10 and run[8] is not None
        assert run[7] == (datetime.now(UTC) - timedelta(days=1)).date()

        assert (
            conn.execute(
                "SELECT count(*) FROM forecast.points WHERE run_id = %s", (run_id,)
            ).fetchone()[0]
            == 24 * 3 * 7
        )
        assert (
            conn.execute(
                "SELECT count(*) FROM forecast.series WHERE run_id = %s", (run_id,)
            ).fetchone()[0]
            == 24 * 3
        )
        metrics = conn.execute(
            "SELECT model, split FROM forecast.model_metrics WHERE run_id = %s", (run_id,)
        ).fetchall()
        assert len(metrics) == 6 and {m[0] for m in metrics} == {
            "moving_average_28",
            "seasonal_naive_7",
            "hgb_direct",
        }
        # V2 step 1a: bias for every split, range quality on the test window only.
        quality = conn.execute(
            """SELECT split, count(*) FILTER (WHERE bias IS NOT NULL),
                      count(*) FILTER (WHERE interval_coverage BETWEEN 0 AND 1
                                         AND interval_width > 0)
                 FROM forecast.model_metrics WHERE run_id = %s GROUP BY split ORDER BY split""",
            (run_id,),
        ).fetchall()
        assert quality == [("test", 3, 3), ("validation", 3, 0)]
        # V2 step 1b: 95 % range next to the 80 % one, nested, and its calibration per level group.
        ranges = conn.execute(
            """SELECT count(*), count(*) FILTER (WHERE lower95 <= lower AND lower <= yhat
                                                  AND yhat <= upper AND upper <= upper95)
                 FROM forecast.points WHERE run_id = %s""",
            (run_id,),
        ).fetchone()
        assert ranges[0] == ranges[1] > 0
        calibration = conn.execute(
            """SELECT level, count(*), sum(n_calibration) > 0, bool_and(q_low <= q_high)
                 FROM forecast.interval_calibration WHERE run_id = %s GROUP BY level ORDER BY level""",
            (run_id,),
        ).fetchall()
        assert calibration == [(80, 6, True, True), (95, 6, True, True)]
        assert (
            conn.execute(
                """SELECT count(*) FROM forecast.model_metrics
                WHERE run_id = %s AND split = 'test' AND interval95_coverage > interval_coverage""",
                (run_id,),
            ).fetchone()[0]
            == 3
        )
        per_horizon = conn.execute(
            """SELECT count(*), count(DISTINCT horizon_day), min(horizon_day), max(horizon_day)
                 FROM forecast.horizon_metrics WHERE run_id = %s""",
            (run_id,),
        ).fetchone()
        assert per_horizon == (3 * 2 * 7, 7, 1, 7)  # 3 models x 2 splits x 7 days ahead
        labels = conn.execute(
            """SELECT (SELECT count(*) FROM forecast.promotions),
                      (SELECT count(*) FROM forecast.injected_anomalies),
                      (SELECT count(*) FROM forecast.injected_anomalies a
                         JOIN forecast.demand_daily d USING (product_id, location_id, day)
                        WHERE d.units = a.actual_units)"""
        ).fetchone()
        assert labels[0] > 0 and labels[1] > 0 and labels[2] == labels[1]
        assert "promo_target" in run[6] and "store" in run[6]

        # V2 step 1c: explanations exist exactly when the ML model is served; never for fallbacks.
        status, served = conn.execute(
            """SELECT r.explanation_status, m.name FROM forecast.runs r
                 JOIN forecast.model_versions m ON m.id = r.served_model_version_id
                WHERE r.id = %s""",
            (run_id,),
        ).fetchone()
        explained, on_fallback, importance = conn.execute(
            """SELECT (SELECT count(*) FROM forecast.explanations WHERE run_id = %s),
                      (SELECT count(*) FROM forecast.explanations e JOIN forecast.series s
                          USING (run_id, product_id, location_id) WHERE e.run_id = %s AND s.is_fallback),
                      (SELECT count(*) FROM forecast.feature_importance WHERE run_id = %s)""",
            (run_id, run_id, run_id),
        ).fetchone()
        if served == "hgb_direct":
            # one fewer than the model columns: season_sin + season_cos are shown as "season"
            assert status == "OK" and explained == run[2] - run[3] and importance == len(run[6]) - 1
        else:
            assert status == "NOT_ML" and explained == 0 and importance == 0
        assert on_fallback == 0

        kinds = dict(conn.execute("SELECT name, kind FROM forecast.model_versions").fetchall())
        assert kinds["hgb_direct"] == "ML" and kinds["category_average"] == "FALLBACK"

        first_day = conn.execute(
            "SELECT min(target_day) FROM forecast.points WHERE run_id = %s", (run_id,)
        ).fetchone()[0]
        assert first_day == run[7] + timedelta(
            days=1
        )  # forecasts start the day after the data ends


def test_a_forecast_run_changes_no_inventory_orders_or_events(catalog: dict) -> None:
    url = catalog["url"]
    load_history(url)
    with psycopg.connect(url) as conn:  # give the system some real stock and a sale to chew on
        product = conn.execute("SELECT id FROM products ORDER BY sku LIMIT 1").fetchone()[0]
        store = conn.execute("SELECT id FROM locations WHERE code = 'S-1'").fetchone()[0]
        conn.execute(
            "INSERT INTO inventory_ledger (product_id, location_id, movement_type, on_hand_delta) "
            "VALUES (%s, %s, 'RECEIPT', 50)",
            (product, store),
        )
        conn.commit()
    before = counts(url)
    assert before["inventory_ledger"] == 1

    pipeline.run_forecast(new_run(), 7)

    assert counts(url) == before
    with psycopg.connect(url) as conn:
        assert conn.execute("SELECT on_hand FROM inventory_balances").fetchone()[0] == 50


def test_only_one_run_at_a_time(catalog: dict) -> None:
    load_history(catalog["url"])
    first = new_run()
    with pytest.raises(repository.RunInProgress):
        new_run()
    pipeline.run_forecast(first, 7)
    assert new_run()  # allowed again once the first run has finished


def test_a_run_without_history_fails_with_a_clear_message(catalog: dict) -> None:
    run_id = new_run()
    with pytest.raises(ValueError, match="no demand history"):
        pipeline.run_forecast(run_id, 7)
    with connect() as conn:
        run = repository.get_run(conn, run_id)
    assert run["status"] == "FAILED" and "no demand history" in run["error"]
    assert new_run()  # a failed run does not block the next one


def test_a_crashed_run_is_marked_abandoned_after_30_minutes(catalog: dict) -> None:
    run_id = new_run()
    with psycopg.connect(catalog["url"]) as conn:
        conn.execute(
            "UPDATE forecast.runs SET started_at = now() - interval '31 minutes' WHERE id = %s",
            (run_id,),
        )
        conn.commit()
    new_id = new_run()
    assert new_id != run_id
    with connect() as conn:
        assert repository.get_run(conn, run_id)["status"] == "FAILED"


def test_old_runs_are_pruned_but_the_latest_five_are_kept(catalog: dict) -> None:
    load_history(catalog["url"])
    ids = []
    for _ in range(7):
        run_id = new_run(horizon=3)
        pipeline.run_forecast(run_id, 3)
        ids.append(run_id)
        time.sleep(0.01)
    with psycopg.connect(catalog["url"]) as conn:
        kept = {r[0] for r in conn.execute("SELECT id::text FROM forecast.runs").fetchall()}
        assert kept == set(ids[-5:])
        assert conn.execute("SELECT count(DISTINCT run_id) FROM forecast.points").fetchone()[0] == 5


def test_ledger_sales_of_complete_days_are_rolled_up_and_today_is_not(catalog: dict) -> None:
    url = catalog["url"]
    with psycopg.connect(url) as conn:
        product = conn.execute("SELECT id FROM products ORDER BY sku LIMIT 1").fetchone()[0]
        store = conn.execute("SELECT id FROM locations WHERE code = 'S-1'").fetchone()[0]
        conn.execute(
            "INSERT INTO inventory_ledger (product_id, location_id, movement_type, on_hand_delta) VALUES (%s,%s,'RECEIPT',500)",
            (product, store),
        )
        for days_ago, qty in ((3, 4), (3, 2), (1, 7), (0, 5)):
            conn.execute(
                "INSERT INTO inventory_ledger (product_id, location_id, movement_type, on_hand_delta, occurred_at) "
                "VALUES (%s,%s,'SALE',%s, now() - make_interval(days => %s))",
                (product, store, -qty, days_ago),
            )
        conn.commit()
    with connect() as conn:
        assert repository.aggregate_ledger(conn) == 2  # day-3 and day-1; today is incomplete
        conn.commit()
        assert repository.aggregate_ledger(conn) == 2  # idempotent: same rows, no duplicates
        conn.commit()
    with psycopg.connect(url) as conn:
        rows = conn.execute(
            "SELECT day, units, source FROM forecast.demand_daily ORDER BY day"
        ).fetchall()
    today = datetime.now(UTC).date()
    assert [(r[0], r[1], r[2]) for r in rows] == [
        (today - timedelta(days=3), 6, "LEDGER"),
        (today - timedelta(days=1), 7, "LEDGER"),
    ]


def test_real_sales_override_synthetic_rows_for_the_same_day(catalog: dict) -> None:
    url = catalog["url"]
    load_history(url, days=120, new_share=0.0)
    with psycopg.connect(url) as conn:
        product, store = conn.execute(
            "SELECT p.id, l.id FROM products p, locations l WHERE p.sku = 'T-0000' AND l.code = 'S-1'"
        ).fetchone()
        conn.execute(
            "INSERT INTO inventory_ledger (product_id, location_id, movement_type, on_hand_delta) VALUES (%s,%s,'RECEIPT',500)",
            (product, store),
        )
        conn.execute(
            "INSERT INTO inventory_ledger (product_id, location_id, movement_type, on_hand_delta, occurred_at) VALUES (%s,%s,'SALE',-9, now() - interval '1 day')",
            (product, store),
        )
        conn.commit()
    with connect() as conn:
        repository.aggregate_ledger(conn)
        conn.commit()
    with psycopg.connect(url) as conn:
        units, source = conn.execute(
            "SELECT units, source FROM forecast.demand_daily WHERE product_id = %s AND location_id = %s "
            "ORDER BY day DESC LIMIT 1",
            (product, store),
        ).fetchone()
    assert (units, source) == (9, "LEDGER")
