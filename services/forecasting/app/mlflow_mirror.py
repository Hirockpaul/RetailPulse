"""Best-effort MLflow mirroring. PostgreSQL and local model artifacts stay authoritative."""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from typing import Any

from app import artifacts
from app.db import connect

EXPERIMENT_NAME = "RetailPulse synthetic forecasting"


@dataclass(frozen=True)
class MirrorResult:
    run_id: str | None = None
    error: str | None = None


def _payload(run_id: str) -> tuple[dict[str, Any], list[tuple[str, str, float]]]:
    with connect(read_only=True) as conn:
        row = conn.execute(
            """SELECT r.id::text, r.horizon_days, r.data_label, r.history_start::text,
                      r.history_end::text, r.series_count, r.fallback_count, r.feature_set,
                      r.params, m.id::text, m.name, m.version, m.kind, m.params,
                      m.artifact_path, m.artifact_sha256, m.artifact_schema_version
                 FROM forecast.runs r
                 JOIN forecast.model_versions m ON m.id = r.served_model_version_id
                WHERE r.id = %s AND r.status = 'SUCCEEDED'""",
            (run_id,),
        ).fetchone()
        if row is None:
            raise ValueError("Only a successful persisted forecast run can be mirrored.")
        metrics = conn.execute(
            """SELECT model, split, mae::float8, rmse::float8, wape::float8, bias::float8,
                      interval_coverage::float8, interval_width::float8,
                      interval95_coverage::float8, interval95_width::float8
                 FROM forecast.model_metrics WHERE run_id = %s""",
            (run_id,),
        ).fetchall()
    keys = [
        "mae",
        "rmse",
        "wape",
        "bias",
        "interval_coverage",
        "interval_width",
        "interval95_coverage",
        "interval95_width",
    ]
    flat_metrics = [
        (f"{split}.{model}.{key}", key, float(value))
        for model, split, *values in metrics
        for key, value in zip(keys, values, strict=True)
        if value is not None
    ]
    return (
        {
            "runId": row[0],
            "horizonDays": row[1],
            "dataLabel": row[2],
            "historyStart": row[3],
            "historyEnd": row[4],
            "seriesCount": row[5],
            "fallbackCount": row[6],
            "featureSet": row[7],
            "runParams": row[8],
            "identity": artifacts.ModelIdentity(
                id=row[9],
                name=row[10],
                version=row[11],
                kind=row[12],
                artifact_path=row[14],
                artifact_sha256=row[15],
                artifact_schema_version=row[16],
            ),
            "modelParams": row[13],
        },
        flat_metrics,
    )


def mirror(run_id: str, tracking_uri: str) -> MirrorResult:
    """Mirror one committed run; return an error instead of affecting the forecast."""
    mlflow_run_id: str | None = None
    client = None
    try:
        # Keep an unavailable optional server from delaying the completed forecast.
        os.environ.setdefault("MLFLOW_HTTP_REQUEST_TIMEOUT", "3")
        os.environ.setdefault("MLFLOW_HTTP_REQUEST_MAX_RETRIES", "0")
        from mlflow import MlflowClient
        from mlflow.entities import Metric, Param, RunTag

        payload, metric_rows = _payload(run_id)
        identity = payload["identity"]
        loaded = artifacts.load_artifact(identity)
        client = MlflowClient(tracking_uri=tracking_uri)
        experiment = client.get_experiment_by_name(EXPERIMENT_NAME)
        experiment_id = (
            experiment.experiment_id
            if experiment is not None
            else client.create_experiment(EXPERIMENT_NAME)
        )
        created = client.create_run(
            experiment_id,
            run_name=f"forecast-{run_id}",
            tags={"retailpulse.synthetic": "true", "retailpulse.source": "postgresql"},
        )
        mlflow_run_id = created.info.run_id
        now = int(time.time() * 1000)
        params = {
            "forecast_run_id": run_id,
            "served_model": identity.name,
            "model_version": identity.version,
            "model_kind": identity.kind,
            "horizon_days": payload["horizonDays"],
            "data_label": payload["dataLabel"],
            "history_start": payload["historyStart"],
            "history_end": payload["historyEnd"],
            "series_count": payload["seriesCount"],
            "fallback_count": payload["fallbackCount"],
            "artifact_sha256": identity.artifact_sha256,
            "feature_set": json.dumps(payload["featureSet"], separators=(",", ":")),
            "run_params": json.dumps(payload["runParams"], sort_keys=True, separators=(",", ":")),
            "model_params": json.dumps(
                payload["modelParams"], sort_keys=True, separators=(",", ":")
            ),
        }
        client.log_batch(
            mlflow_run_id,
            metrics=[Metric(name, value, now, 0) for name, _key, value in metric_rows],
            params=[Param(key, str(value)) for key, value in params.items()],
            tags=[RunTag("retailpulse.artifact_schema", str(identity.artifact_schema_version))],
        )
        client.log_artifact(mlflow_run_id, str(loaded.local_path), artifact_path="model")
        client.set_terminated(mlflow_run_id, "FINISHED")
        return MirrorResult(run_id=mlflow_run_id)
    except Exception as exc:
        if client is not None and mlflow_run_id is not None:
            try:
                client.set_terminated(mlflow_run_id, "FAILED")
            except Exception:
                pass
        safe = f"{type(exc).__name__}: {exc}".replace(tracking_uri, "<tracking-uri>")
        return MirrorResult(error=safe[:500])
