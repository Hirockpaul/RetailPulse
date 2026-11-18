"""RetailPulse forecasting service (internal).

Forecasts are ADVISORY: this service reads sales history and writes only the `forecast` schema.
It never changes inventory and never creates orders or transfers. It has no authentication of
its own: run it on localhost or a private network only.
"""

from __future__ import annotations

import threading
from datetime import UTC, datetime
from typing import Any

import psycopg
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from app import pipeline, repository
from app.db import connect
from app.schemas import RunRequest, RunStarted

app = FastAPI(title="RetailPulse Forecasting", version="0.2.0")


class Health(BaseModel):
    status: str
    service: str
    database: str
    checked_at: datetime


@app.get("/health", response_model=Health)
def health() -> Health:
    try:
        with connect(read_only=True) as conn:
            conn.execute("SELECT 1")
        database = "up"
    except Exception:
        database = "down"
    return Health(
        status="ok" if database == "up" else "degraded",
        service="retailpulse-forecasting",
        database=database,
        checked_at=datetime.now(UTC),
    )


@app.post("/forecast/run", status_code=202, response_model=RunStarted, response_model_by_alias=True)
def start_run(request: RunRequest | None = None) -> RunStarted:
    """Start a forecast run in the background; poll /forecast/runs/{id}. One run at a time."""
    horizon = (request or RunRequest()).horizon_days
    try:
        with connect() as conn:
            run_id = repository.start_run(conn, horizon)
    except repository.RunInProgress as exc:
        raise HTTPException(
            status_code=409, detail="A forecast run is already in progress."
        ) from exc
    threading.Thread(target=_run_safely, args=(run_id, horizon), daemon=True).start()
    return RunStarted(run_id=run_id, status="RUNNING")


def _run_safely(run_id: str, horizon: int) -> None:
    try:
        pipeline.run_forecast(run_id, horizon)
    except Exception:  # already recorded on the run row; nothing more to do in the thread
        pass


@app.post("/monitoring/run")
def start_monitoring() -> dict[str, Any]:
    """Run model monitoring now (V2 3c-1). Synchronous: a few seconds. It never retrains,
    activates or changes a forecast; a failure is stored as a FAILED monitoring run."""
    from app.monitoring.run import run_monitoring

    monitoring_id = run_monitoring("MANUAL")
    with connect(read_only=True) as conn:
        row = conn.execute(
            """SELECT status, data_drift_status, prediction_drift_status, performance_status,
                      current_days, error
                 FROM forecast.monitoring_runs WHERE id = %s""",
            (monitoring_id,),
        ).fetchone()
    keys = ["status", "dataDrift", "predictionDrift", "performance", "currentDays", "error"]
    return {"monitoringRunId": monitoring_id, **dict(zip(keys, row, strict=True))}


@app.get("/forecast/runs/latest")
def latest_run() -> dict[str, Any]:
    with connect(read_only=True) as conn:
        run = repository.latest_run(conn)
    if run is None:
        raise HTTPException(status_code=404, detail="No forecast run yet.")
    return run


@app.get("/forecast/runs/{run_id}")
def get_run(run_id: str) -> dict[str, Any]:
    try:
        with connect(read_only=True) as conn:
            run = repository.get_run(conn, run_id)
    except psycopg.errors.InvalidTextRepresentation as exc:
        raise HTTPException(status_code=400, detail="Invalid run id.") from exc
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found.")
    return run


@app.get("/forecast/{sku}/{location_code}")
def get_forecast(sku: str, location_code: str) -> dict[str, Any]:
    """The latest successful run's forecast for one product at one store."""
    with connect(read_only=True) as conn:
        result = repository.series_forecast(conn, sku, location_code)
    if result is None:
        raise HTTPException(status_code=404, detail="No forecast for that product and store.")
    return result
