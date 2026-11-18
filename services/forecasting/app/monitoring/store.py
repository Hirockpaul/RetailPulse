"""SQL for model monitoring (V2 step 3c-1). Reads the registry, kept forecasts and metrics; writes
only `forecast.monitoring_runs` / `forecast.monitoring_results` (immutable rows)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

import numpy as np
import psycopg

from app.artifacts import ModelIdentity
from app.monitoring.monitor import MonitoringOutcome, PointsSample

KEEP_MONITORING_RUNS = 30
ACCURACY_HORIZON = 7


@dataclass(frozen=True)
class ActiveModel:
    identity: ModelIdentity
    training_end: date | None


def active_model(conn: psycopg.Connection) -> ActiveModel | None:
    row = conn.execute(
        """SELECT id::text, name, version, kind, artifact_path, artifact_sha256,
                  artifact_schema_version, training_end
             FROM forecast.model_versions WHERE status = 'ACTIVE'"""
    ).fetchone()
    return ActiveModel(ModelIdentity(*row[:7]), row[7]) if row else None


def store_codes(conn: psycopg.Connection) -> dict[str, str]:
    rows = conn.execute(
        "SELECT id::text, code::text FROM locations WHERE type = 'STORE'"
    ).fetchall()
    return dict(rows)


def kept_points(conn: psycopg.Connection) -> PointsSample:
    """Days 1-7 of every kept successful run, model-served series only (fallback excluded)."""
    rows = conn.execute(
        """SELECT p.product_id::text, p.location_id::text, p.target_day, p.yhat::float8
             FROM forecast.points p
             JOIN forecast.runs r ON r.id = p.run_id AND r.status = 'SUCCEEDED'
             JOIN forecast.series s ON s.run_id = p.run_id AND s.product_id = p.product_id
                                   AND s.location_id = p.location_id AND NOT s.is_fallback
            WHERE p.horizon_day <= %s""",
        (ACCURACY_HORIZON,),
    ).fetchall()
    return PointsSample(
        [r[0] for r in rows],
        [r[1] for r in rows],
        [r[2] for r in rows],
        np.array([r[3] for r in rows], dtype=float),
    )


def backtest_test_wape(conn: psycopg.Connection, model_name: str) -> float | None:
    """The ACTIVE model's honest test-window WAPE from the latest successful run."""
    row = conn.execute(
        """SELECT m.wape::float8
             FROM forecast.model_metrics m
             JOIN forecast.runs r ON r.id = m.run_id AND r.status = 'SUCCEEDED'
            WHERE m.model = %s AND m.split = 'test'
            ORDER BY r.finished_at DESC NULLS LAST LIMIT 1""",
        (model_name,),
    ).fetchone()
    return row[0] if row else None


def _num(x: float | None) -> float | None:
    return None if x is None or not np.isfinite(x) else round(float(x), 6)


def save(
    conn: psycopg.Connection,
    trigger: str,
    forecast_run_id: str | None,
    active: ActiveModel | None,
    outcome: MonitoringOutcome,
    days: np.ndarray,
) -> str:
    w = outcome.windows

    def day(idx: int | None) -> date | None:
        return None if idx is None else days[idx].astype("datetime64[D]").item()

    ref = w.reference or (None, None)
    cur = w.current or (None, None)
    run_id = conn.execute(
        """INSERT INTO forecast.monitoring_runs
             (trigger, forecast_run_id, model_version_id, model_name, training_end,
              latest_data_day, reference_start, reference_end, current_start, current_end,
              current_days, status, data_drift_status, prediction_drift_status, performance_status)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'SUCCEEDED', %s, %s, %s)
           RETURNING id::text""",
        (
            trigger,
            forecast_run_id,
            active.identity.id if active else None,
            active.identity.name if active else None,
            active.training_end if active else None,
            w.latest_data_day,
            day(ref[0]),
            day(ref[1]),
            day(cur[0]),
            day(cur[1]),
            w.current_days,
            outcome.data_drift_status,
            outcome.prediction_drift_status,
            outcome.performance_status,
        ),
    ).fetchone()[0]
    with conn.cursor() as c:
        for r in outcome.results:
            d = r.drift
            c.execute(
                """INSERT INTO forecast.monitoring_results
                     (run_id, check_kind, subject, location_id, n_reference, n_current, psi, ks_d,
                      ks_p, wape, bias, backtest_wape, n_points, n_days, status)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (
                    run_id,
                    r.check_kind,
                    r.subject,
                    r.location_id,
                    d.n_reference if d else None,
                    d.n_current if d else None,
                    _num(d.psi) if d else None,
                    _num(d.ks_d) if d else None,
                    _num(d.ks_p) if d else None,
                    _num(r.wape),
                    _num(r.bias),
                    _num(r.backtest_wape),
                    r.n_points,
                    r.n_days,
                    r.status,
                ),
            )
    prune(conn)
    return run_id


def save_failed(
    conn: psycopg.Connection, trigger: str, forecast_run_id: str | None, error: str
) -> str:
    run_id = conn.execute(
        """INSERT INTO forecast.monitoring_runs (trigger, forecast_run_id, status, error)
           VALUES (%s, %s, 'FAILED', %s) RETURNING id::text""",
        (trigger, forecast_run_id, error[:500]),
    ).fetchone()[0]
    prune(conn)
    return run_id


def prune(conn: psycopg.Connection, keep: int = KEEP_MONITORING_RUNS) -> None:
    conn.execute(
        """DELETE FROM forecast.monitoring_runs WHERE id NOT IN (
             SELECT id FROM forecast.monitoring_runs ORDER BY created_at DESC LIMIT %s)""",
        (keep,),
    )
