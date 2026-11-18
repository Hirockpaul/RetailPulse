"""SQL for the forecasting service.

Every statement that WRITES targets the `forecast` schema (see tests/test_write_guard.py).
Reads may use the rest of the database (catalog, sales ledger).
"""

from __future__ import annotations

import hashlib
import json
from datetime import timedelta
from typing import Any

import numpy as np
import psycopg

from app import artifacts
from app.config import ACTIVATION_WAPE_GAIN, DEFAULT_HORIZON_DAYS, PIPELINE_VERSION
from app.data import History
from app.models.ml import FEATURES  # descriptive list for the model version

KEEP_RUNS = 5


class RunInProgress(Exception):
    """Another forecast run is already running."""


def active_model_name(conn: psycopg.Connection) -> str | None:
    """The manager-controlled production model. None only before the first successful run."""
    row = conn.execute(
        "SELECT name FROM forecast.model_versions WHERE status = 'ACTIVE'"
    ).fetchone()
    return row[0] if row else None


def active_model(conn: psycopg.Connection) -> artifacts.ModelIdentity | None:
    row = conn.execute(
        """SELECT id::text, name, version, kind, artifact_path, artifact_sha256,
                  artifact_schema_version
             FROM forecast.model_versions WHERE status = 'ACTIVE'"""
    ).fetchone()
    return artifacts.ModelIdentity(*row) if row else None


def eligibility(active_wape: float, candidate_wape: float) -> tuple[str, str]:
    """Candidate state from the pre-registered validation-only material-improvement gate."""
    if not np.isfinite(active_wape) or not np.isfinite(candidate_wape):
        return "REJECTED", "Validation WAPE is unavailable, so the activation gate cannot pass."
    gain = active_wape - candidate_wape
    status = "ELIGIBLE" if gain >= ACTIVATION_WAPE_GAIN else "REJECTED"
    verb = "passes" if status == "ELIGIBLE" else "does not pass"
    return (
        status,
        f"Validation WAPE {candidate_wape:.4f} vs ACTIVE {active_wape:.4f}: "
        f"gain {gain:.4f}; {verb} the {ACTIVATION_WAPE_GAIN:.4f} activation gate.",
    )


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
            "2",
            "ML",
            "Global gradient boosting (scikit-learn HistGradientBoostingRegressor, Poisson loss), "
            "direct multi-horizon, trained on lag, calendar and promotion-calendar features "
            "(weekday, category and store as numeric codes).",
            {
                "loss": "poisson",
                "learning_rate": 0.08,
                "max_iter": 200,
                "max_leaf_nodes": 31,
                "min_samples_leaf": 200,
                "features": FEATURES,
                "categoricalEncoding": "numeric codes (no native categorical splits)",
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


def _update_registry(
    conn: psycopg.Connection,
    run_id: str,
    hist: History,
    outcome: Any,
    versions: dict[str, str],
) -> None:
    """Persist evaluation metadata and bootstrap/classify registry states without auto-switching."""
    active = conn.execute(
        "SELECT id::text, name FROM forecast.model_versions WHERE status = 'ACTIVE' FOR UPDATE"
    ).fetchone()
    served = outcome.selection.model
    if active is None:
        target_id = versions[served]
        conn.execute(
            """UPDATE forecast.model_versions
                  SET status = 'ACTIVE', eligibility_reason = %s, evaluated_at = now()
                WHERE id = %s AND kind <> 'FALLBACK'""",
            ("First successful run: automatic-selection bootstrap.", target_id),
        )
        conn.execute(
            """INSERT INTO forecast.model_activations (action, to_model_id, reason)
               VALUES ('BOOTSTRAP', %s, %s)""",
            (target_id, "First successful run: automatic-selection bootstrap"),
        )
        active = (target_id, served)
    elif active[1] != served:
        raise ValueError(
            f"Registry ACTIVE model {active[1]!r} does not match served model {served!r}."
        )

    active_wape = float(outcome.metrics[active[1]]["validation"]["wape"])
    feature_config = json.dumps(
        {
            "pipelineVersion": PIPELINE_VERSION,
            "features": outcome.feature_names,
            "horizonDays": outcome.horizon,
        }
    )
    for name, model_id in versions.items():
        status_row = conn.execute(
            """SELECT status::text, kind, eligibility_reason
                 FROM forecast.model_versions WHERE id = %s""",
            (model_id,),
        ).fetchone()
        assert status_row is not None
        current_status, kind, current_reason = status_row
        status, reason = current_status, current_reason
        if name == active[1]:
            status, reason = "ACTIVE", "Served because this model is ACTIVE in the registry."
        elif kind == "FALLBACK":
            status, reason = "REJECTED", "Per-series fallback policy; not globally activatable."
        elif current_status != "RETIRED":
            candidate_wape = float(outcome.metrics[name]["validation"]["wape"])
            status, reason = eligibility(active_wape, candidate_wape)
        conn.execute(
            """UPDATE forecast.model_versions
                  SET status = %s, latest_run_id = %s, training_start = %s, training_end = %s,
                      feature_config = %s, eligibility_reason = %s, evaluated_at = now()
                WHERE id = %s""",
            (
                status,
                run_id,
                hist.days[0].astype("datetime64[D]").item(),
                hist.days[-1].astype("datetime64[D]").item(),
                feature_config,
                reason,
                model_id,
            ),
        )


def _ensure_artifacts(
    conn: psycopg.Connection,
    outcome: Any,
    versions: dict[str, str],
) -> None:
    """Materialize each activatable registry version exactly once."""
    for name, model_id in versions.items():
        row = conn.execute(
            """SELECT id::text, name, version, kind, params, artifact_path, artifact_sha256,
                      artifact_schema_version
                 FROM forecast.model_versions WHERE id = %s FOR UPDATE""",
            (model_id,),
        ).fetchone()
        assert row is not None
        identity = artifacts.ModelIdentity(
            id=row[0],
            name=row[1],
            version=row[2],
            kind=row[3],
            artifact_path=row[5],
            artifact_sha256=row[6],
            artifact_schema_version=row[7],
        )
        if identity.kind == "FALLBACK" or identity.artifact_path is not None:
            continue
        stored = artifacts.write_artifact(
            identity,
            params=row[4],
            feature_names=outcome.feature_names,
            max_horizon=max(outcome.horizon, DEFAULT_HORIZON_DAYS),
            model=outcome.candidate_model if name == "hgb_direct" else None,
        )
        conn.execute(
            """UPDATE forecast.model_versions
                  SET artifact_path = %s, artifact_sha256 = %s, artifact_schema_version = %s,
                      artifact_created_at = now()
                WHERE id = %s AND artifact_path IS NULL""",
            (stored.path, stored.sha256, stored.schema_version, model_id),
        )


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
        json.dumps([PIPELINE_VERSION, outcome.feature_names, outcome.horizon]).encode()
    ).hexdigest()[:12]
    conn.execute(
        """UPDATE forecast.runs SET
              status = 'SUCCEEDED', finished_at = now(), data_label = %s,
              history_start = %s, history_end = %s, train_end = %s,
              validation_start = %s, validation_end = %s, test_start = %s, test_end = %s,
              series_count = %s, fallback_count = %s, served_model_version_id = %s,
              selection_reason = %s, ml_beat_baseline = %s, feature_set = %s, params = %s,
              explanation_status = %s
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
            outcome.feature_names,
            json.dumps({"pipelineVersion": PIPELINE_VERSION, "digest": params_digest}),
            outcome.explanation_status,
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
                         (run_id, model, split, mae, rmse, wape, bias, interval_coverage,
                          interval_width, interval95_coverage, interval95_width, n_points,
                          n_series)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                    (
                        run_id,
                        model,
                        split,
                        num(m["mae"]),
                        num(m["rmse"]),
                        num(m["wape"]),
                        num(m["bias"]),
                        num(m["interval_coverage"]),
                        num(m["interval_width"]),
                        num(m["interval95_coverage"]),
                        num(m["interval95_width"]),
                        m["n_points"],
                        m["n_series"],
                    ),
                )
        _ensure_artifacts(conn, outcome, versions)
        _update_registry(conn, run_id, hist, outcome, versions)
        for g in outcome.interval_groups:
            cur.execute(
                """INSERT INTO forecast.interval_calibration
                     (run_id, level, group_index, forecast_from, forecast_to, q_low, q_high,
                      n_calibration, pooled, test_coverage, test_points)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (
                    run_id,
                    g["level"],
                    g["group"],
                    g["forecast_from"],
                    None if g["forecast_to"] == float("inf") else g["forecast_to"],
                    round(g["q_low"], 4),
                    round(g["q_high"], 4),
                    g["n_calibration"],
                    g["pooled"],
                    num(g["test_coverage"]),
                    g["test_points"],
                ),
            )
        if outcome.explanations is not None:
            _save_explanations(cur, run_id, hist, outcome)
        for h in outcome.horizon_metrics:
            cur.execute(
                """INSERT INTO forecast.horizon_metrics
                     (run_id, model, split, horizon_day, mae, wape, bias, n_points)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
                (
                    run_id,
                    h["model"],
                    h["split"],
                    h["horizon_day"],
                    num(h["mae"]),
                    num(h["wape"]),
                    num(h["bias"]),
                    h["n_points"],
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
            "yhat, lower, upper, lower95, upper95) FROM STDIN"
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
                            round(float(outcome.lower95[i, h]), 4),
                            round(float(outcome.upper95[i, h]), 4),
                        )
                    )
    prune_runs(conn)


def set_mlflow_status(
    conn: psycopg.Connection,
    run_id: str,
    status: str,
    *,
    mlflow_run_id: str | None = None,
    error: str | None = None,
) -> None:
    conn.execute(
        """UPDATE forecast.runs
              SET mlflow_status = %s, mlflow_run_id = %s, mlflow_error = %s
            WHERE id = %s""",
        (status, mlflow_run_id, error[:500] if error else None, run_id),
    )


def _save_explanations(cur: psycopg.Cursor, run_id: str, hist: History, outcome: Any) -> None:
    """The first forecast day per series split into contributions (fallback series are not the
    model's forecast, so they get none), and the run's overall feature importance."""
    ex = outcome.explanations
    names = ex.feature_names
    with cur.copy(
        "COPY forecast.explanations (run_id, product_id, location_id, horizon_day, base_log, "
        "forecast, contributions) FROM STDIN"
    ) as copy:
        for i in range(hist.n_series):
            if outcome.is_fallback[i]:
                continue
            order = np.argsort(-np.abs(ex.contributions[i]))
            items = [
                {
                    "feature": names[j],
                    "value": round(float(ex.values[i, j]), 4),
                    "contribution": round(float(ex.contributions[i, j]), 6),
                }
                for j in order
            ]
            copy.write_row(
                (
                    run_id,
                    hist.product_ids[i],
                    hist.location_ids[i],
                    1,
                    round(ex.base_log, 6),
                    round(float(ex.forecast[i]), 4),
                    json.dumps(items),
                )
            )
    ranked = np.argsort(-ex.global_importance)
    for rank, j in enumerate(ranked, start=1):
        cur.execute(
            """INSERT INTO forecast.feature_importance (run_id, feature, mean_abs_contribution, rank)
               VALUES (%s, %s, %s, %s)""",
            (run_id, names[j], round(float(ex.global_importance[j]), 6), rank),
        )


def save_anomalies(
    conn: psycopg.Connection, run_id: str, hist: History, findings: list[dict]
) -> int:
    """Store new unusual-sales findings; ones already found by an earlier run are skipped, so a
    finding (and the review a person attached to it) is never rewritten. Returns how many are new."""
    from app.anomalies.detect import RULE

    new = 0
    with conn.cursor() as cur:
        for f in findings:
            cur.execute(
                """INSERT INTO forecast.anomaly_detections
                     (product_id, location_id, day, kind, severity, score, observed, expected,
                      method, rule, explanation, run_id)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'robust_z', %s, %s, %s)
                   ON CONFLICT (product_id, location_id, day, kind) DO NOTHING""",
                (
                    hist.product_ids[f["series"]],
                    hist.location_ids[f["series"]],
                    f["day"].astype("datetime64[D]").item(),
                    f["kind"],
                    f["severity"],
                    f["score"],
                    f["observed"],
                    f["expected"],
                    RULE,
                    f["explanation"],
                    run_id,
                ),
            )
            new += cur.rowcount
    return new


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
       m.name, m.kind, r.selection_reason, r.ml_beat_baseline, r.error,
       r.mlflow_status::text, r.mlflow_run_id, r.mlflow_error"""


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
        "mlflowStatus",
        "mlflowRunId",
        "mlflowError",
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
        """SELECT target_day, horizon_day, yhat, lower, upper, lower95, upper95 FROM forecast.points
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
                "lower95": None if p[5] is None else float(p[5]),
                "upper95": None if p[6] is None else float(p[6]),
            }
            for p in points
        ],
    }
