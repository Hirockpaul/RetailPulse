"""Load the synthetic history into forecast.demand_daily (source = 'SYNTHETIC')."""

from __future__ import annotations

import pandas as pd
import psycopg


def read_catalog(conn: psycopg.Connection) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Active products (with category name) and store locations."""
    products = conn.execute(
        """SELECT p.id::text AS product_id, c.name::text AS category
             FROM products p JOIN categories c ON c.id = p.category_id
            WHERE p.is_active ORDER BY p.sku"""
    ).fetchall()
    stores = conn.execute(
        "SELECT id::text AS location_id FROM locations WHERE type = 'STORE' ORDER BY code"
    ).fetchall()
    return (
        pd.DataFrame(products, columns=["product_id", "category"]),
        pd.DataFrame(stores, columns=["location_id"]),
    )


def replace_synthetic(
    conn: psycopg.Connection,
    history: pd.DataFrame,
    promotions: pd.DataFrame | None = None,
    anomalies: pd.DataFrame | None = None,
) -> int:
    """Replace all SYNTHETIC demand rows with `history`, and the synthetic promotion calendar and
    anomaly labels with `promotions` / `anomalies`, in one transaction. Real (LEDGER) rows are
    never touched."""
    conn.execute("DELETE FROM forecast.demand_daily WHERE source = 'SYNTHETIC'")
    conn.execute("DELETE FROM forecast.promotions WHERE source = 'SYNTHETIC'")
    conn.execute("DELETE FROM forecast.injected_anomalies WHERE source = 'SYNTHETIC'")
    with conn.cursor() as cur:
        with cur.copy(
            "COPY forecast.demand_daily (product_id, location_id, day, units, source) FROM STDIN"
        ) as copy:
            for product_id, location_id, day, units in history.itertuples(index=False):
                copy.write_row((product_id, location_id, day, int(units), "SYNTHETIC"))
        if promotions is not None and not promotions.empty:
            with cur.copy(
                "COPY forecast.promotions (product_id, location_id, day, uplift, source) FROM STDIN"
            ) as copy:
                for product_id, location_id, day, uplift in promotions.itertuples(index=False):
                    copy.write_row((product_id, location_id, day, float(uplift), "SYNTHETIC"))
        if anomalies is not None and not anomalies.empty:
            with cur.copy(
                "COPY forecast.injected_anomalies (product_id, location_id, day, kind, "
                "expected_units, actual_units, source) FROM STDIN"
            ) as copy:
                for row in anomalies.itertuples(index=False):
                    product_id, location_id, day, kind, expected, actual = row
                    copy.write_row(
                        (
                            product_id,
                            location_id,
                            day,
                            kind,
                            float(expected),
                            int(actual),
                            "SYNTHETIC",
                        )
                    )
    conn.commit()
    return len(history)
