"""SQL for the forecasting service.

Every statement that WRITES targets the `forecast` schema (see tests/test_write_guard.py).
Reads may use the rest of the database (catalog, sales ledger).
"""

from __future__ import annotations

import hashlib
import json
from datetime import timedelta
from typing import Any

import psycopg

from app.config import DEFAULT_HORIZON_DAYS, PIPELINE_VERSION
from app.data import History
from app.models.ml import FEATURES

KEEP_RUNS = 5


class RunInProgress(Exception):
    """Another forecast run is already running."""


# ---------------------------------------------------------------- demand history


def aggregate_ledger(conn: psycopg.Connection) -> int:
    """Roll real SALE movements of COMPLETE days (UTC) up into forecast.demand_daily."""
    cur = conn.execute(
        """INSERT INTO forecast.demand_daily (product_id, location_id, day, units, source)
           SELECT e.product_id, e.location_id, (e.occurred_at AT TIME ZONE 'UTC')::date,
                  SUM(-e.on_hand_delta)::int, 'LEDGER'
             FROM inventory_ledger e
             JOIN locations l ON l.id = e.location_id AND l.type = 'STORE'
            WHERE e.movement_type = 'SALE'
              AND (e.occurred_at AT TIME ZONE 'UTC')::date < (now() AT TIME ZONE 'UTC')::date
            GROUP BY 1, 2, 3
           ON CONFLICT (product_id, location_id, day)
           DO UPDATE SET units = EXCLUDED.units, source = 'LEDGER'"""
    )
    return cur.rowcount


# ------------------------------------------------------------------------- runs


def start_run(conn: psycopg.Connection, horizon_days: int = DEFAULT_HORIZON_DAYS) -> str:
    """Create a RUNNING row. Raises RunInProgress if another run is active (unique index)."""
    conn.execute(
        """UPDATE forecast.runs SET status = 'FAILED', finished_at = now(),
                  error = 'Abandoned: the service stopped before this run finished.'
            WHERE status = 'RUNNING' AND started_at < now() - interval '30 minutes'"""
    )
    try:
        row = conn.execute(
            "INSERT INTO forecast.runs (horizon_days) VALUES (%s) RETURNING id::text",
            (horizon_days,),
        ).fetchone()
    except psycopg.errors.UniqueViolation as exc:
        conn.rollback()
        raise RunInProgress from exc
    conn.commit()
    assert row is not None
    return row[0]


def fail_run(conn: psycopg.Connection, run_id: str, error: str) -> None:
    conn.execute(
        "UPDATE forecast.runs SET status = 'FAILED', finished_at = now(), error = %s WHERE id = %s",
        (error, run_id),
    )


def _model_params(horizon: int) -> list[tuple[str, str, str, str, dict[str, Any]]]:
    return [
        (
            "moving_average_28",
            "1",
            "BASELINE",
            "Mean of the last 28 days, repeated flat.",
            {"window": 28},
        ),
        (
            "seasonal_naive_7",
            "1",
            "BASELINE",
            "Same weekday of the most recent known week.",
            {"period": 7},
        ),
        (
            "hgb_direct",
            "1",
            "ML",
            "Global gradient boosting (scikit-learn HistGradientBoostingRegressor, Poisson loss), "
            "direct multi-horizon, trained on lag and calendar features.",
            {
                "loss": "poisson",
                "learning_rate": 0.08,
                "max_iter": 200,
                "max_leaf_nodes": 31,
                "min_samples_leaf": 200,
                "features": FEATURES,
                "training_horizon": horizon,
            },
        ),
        (
            "category_average",
            "1",
            "FALLBACK",
            "For series with too little history: the category x store average of comparable series.",
            {"group": "category x store"},
        ),
    ]


def _ensure_model_versions(conn: psycopg.Connection, horizon: int) -> dict[str, str]:
    ids: dict[str, str] = {}
    for name, version, kind, description, params in _model_params(horizon):
        row = conn.execute(
            """INSERT INTO forecast.model_versions (name, version, kind, description, params)
               VALUES (%s, %s, %s, %s, %s)
               ON CONFLICT (name, version) DO UPDATE SET description = EXCLUDED.description,
                                                         params = EXCLUDED.params
               RETURNING id::text""",
            (name, version, kind, description, json.dumps(params)),
        ).fetchone()
        assert row is not None
        ids[name] = row[0]
    return ids


def save_results(conn: psycopg.Connection, run_id: str, hist: History, outcome: Any) -> None:
    """Persist one run in a single transaction and mark it SUCCEEDED."""
    versions = _ensure_model_versions(conn, outcome.horizon)
    w = outcome.windows
    day = hist.days
    label = (
        "MIXED"
        if len(hist.sources) > 1
        else (next(iter(hist.sources)) if hist.sources else "UNKNOWN")
    )
    params_digest = hashlib.sha256(
        json.dumps([PIPELINE_VERSION, FEATURES, outcome.horizon]).encode()
    ).hexdigest()[:12]
    conn.execute(
        """UPDATE forecast.runs SET
              status = 'SUCCEEDED', finished_at = now(), data_label = %s,
              history_start = %s, history_end = %s, train_end = %s,
              validation_start = %s, validation_end = %s, test_start = %s, test_end = %s,
              series_count = %s, fallback_count = %s, served_model_version_id = %s,
              selection_reason = %s, ml_beat_baseline = %s, feature_set = %s, params = %s
            WHERE id = %s""",
        (
            label,
            day[0].astype("datetime64[D]").item(),
            day[-1].item(),
            day[-1].item(),
            day[w.val_start].item(),
            day[w.val_end - 1].item(),
            day[w.test_start].item(),
            day[w.test_end - 1].item(),
            hist.n_series,
            int(outcome.is_fallback.sum()),
            versions[outcome.selection.model],
            outcome.selection.reason,
            outcome.selection.ml_beat_baseline,
            FEATURES,
            json.dumps({"pipelineVersion": PIPELINE_VERSION, "digest": params_digest}),
            run_id,
        ),
    )

    def num(x: float) -> float | None:
        return None if x != x else round(float(x), 4)  # NaN -> NULL

    with conn.cursor() as cur:
        for model, per_split in outcome.metrics.items():
            for split, m in per_split.items():
                cur.execute(
                    """INSERT INTO forecast.model_metrics
                         (run_id, model, split, mae, rmse, wape, n_points, n_series)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
                    (
                        run_id,
                        model,
                        split,
                        num(m["mae"]),
                        num(m["rmse"]),
                        num(m["wape"]),
                        m["n_points"],
                        m["n_series"],
                    ),
                )
        with cur.copy(
            "COPY forecast.series (run_id, product_id, location_id, history_days, model, "
            "is_fallback, avg_daily_28, std_daily_90, sigma, test_wape) FROM STDIN"
        ) as copy:
            for i in range(hist.n_series):
                copy.write_row(
                    (
                        run_id,
                        hist.product_ids[i],
                        hist.location_ids[i],
                        int(hist.history_days[i]),
                        outcome.model_names[i],
                        bool(outcome.is_fallback[i]),
                        round(float(outcome.avg_daily_28[i]), 4),
                        round(float(outcome.std_daily_90[i]), 4),
                        round(float(outcome.sigma[i]), 4),
                        num(outcome.test_wape[i]),
                    )
                )
        with cur.copy(
            "COPY forecast.points (run_id, product_id, location_id, target_day, horizon_day, "
            "yhat, lower, upper) FROM STDIN"
        ) as copy:
            last = day[-1].astype("datetime64[D]").item()
            for i in range(hist.n_series):
                for h in range(outcome.horizon):
                    copy.write_row(
                        (
                            run_id,
                            hist.product_ids[i],
                            hist.location_ids[i],
                            last + timedelta(days=h + 1),
                            h + 1,
                            round(float(outcome.yhat[i, h]), 4),
                            round(float(outcome.lower[i, h]), 4),
                            round(float(outcome.upper[i, h]), 4),
                        )
                    )
    prune_runs(conn)


def prune_runs(conn: psycopg.Connection, keep: int = KEEP_RUNS) -> None:
    """Keep the newest `keep` finished runs (their points are cascade-deleted with them)."""
    conn.execute(
        """DELETE FROM forecast.runs WHERE status <> 'RUNNING' AND id NOT IN (
             SELECT id FROM forecast.runs WHERE status <> 'RUNNING'
              ORDER BY started_at DESC LIMIT %s)""",
        (keep,),
    )


# ------------------------------------------------------------------------ reads

_RUN_COLUMNS = """r.id::text, r.status::text, r.started_at, r.finished_at, r.horizon_days,
       r.data_label, r.history_start, r.history_end, r.series_count, r.fallback_count,
       m.name, m.kind, r.selection_reason, r.ml_beat_baseline, r.error"""


def _run_row(row: tuple) -> dict[str, Any]:
    keys = [
        "id",
        "status",
        "startedAt",
        "finishedAt",
        "horizonDays",
        "dataLabel",
        "historyStart",
        "historyEnd",
        "seriesCount",
        "fallbackCount",
        "servedModel",
        "servedModelKind",
        "selectionReason",
        "mlBeatBaseline",
        "error",
    ]
    return dict(zip(keys, row, strict=True))


def get_run(conn: psycopg.Connection, run_id: str) -> dict[str, Any] | None:
    row = conn.execute(
        f"""SELECT {_RUN_COLUMNS} FROM forecast.runs r
              LEFT JOIN forecast.model_versions m ON m.id = r.served_model_version_id
             WHERE r.id = %s""",
        (run_id,),
    ).fetchone()
    return _run_row(row) if row else None


def latest_run(conn: psycopg.Connection, succeeded_only: bool = False) -> dict[str, Any] | None:
    where = "WHERE r.status = 'SUCCEEDED'" if succeeded_only else ""
    row = conn.execute(
        f"""SELECT {_RUN_COLUMNS} FROM forecast.runs r
              LEFT JOIN forecast.model_versions m ON m.id = r.served_model_version_id
             {where} ORDER BY r.started_at DESC LIMIT 1"""
    ).fetchone()
    return _run_row(row) if row else None


def series_forecast(
    conn: psycopg.Connection, sku: str, location_code: str
) -> dict[str, Any] | None:
    run = latest_run(conn, succeeded_only=True)
    if run is None:
        return None
    head = conn.execute(
        """SELECT s.model, s.is_fallback, s.history_days, s.avg_daily_28, s.std_daily_90, s.sigma,
                  s.test_wape, p.id::text, l.id::text
             FROM forecast.series s
             JOIN products p ON p.id = s.product_id
             JOIN locations l ON l.id = s.location_id
            WHERE s.run_id = %s AND p.sku = %s AND l.code = %s""",
        (run["id"], sku, location_code),
    ).fetchone()
    if head is None:
        return None
    points = conn.execute(
        """SELECT target_day, horizon_day, yhat, lower, upper FROM forecast.points
            WHERE run_id = %s AND product_id = %s AND location_id = %s ORDER BY target_day""",
        (run["id"], head[7], head[8]),
    ).fetchall()
    return {
        "runId": run["id"],
        "sku": sku,
        "locationCode": location_code,
        "model": head[0],
        "isFallback": head[1],
        "historyDays": head[2],
        "avgDaily28": float(head[3]),
        "stdDaily90": float(head[4]),
        "sigma": float(head[5]),
        "testWape": None if head[6] is None else float(head[6]),
        "dataLabel": run["dataLabel"],
        "points": [
            {
                "day": p[0],
                "horizonDay": p[1],
                "yhat": float(p[2]),
                "lower": float(p[3]),
                "upper": float(p[4]),
            }
            for p in points
        ],
    }
