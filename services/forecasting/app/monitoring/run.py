"""One monitoring run: load inputs, compute, store (V2 step 3c-1).

Called after every forecast run (trigger FORECAST_RUN) and on demand (MANUAL). A failure is stored
as a FAILED monitoring run and never changes the forecast run it followed.
"""

from __future__ import annotations

import numpy as np

from app import artifacts
from app.data import load_history
from app.db import connect
from app.models.ml import FeatureBuilder
from app.monitoring import store
from app.monitoring.monitor import MonitoringOutcome, compute, windows_for


def _predictor(active: store.ActiveModel, hist):  # noqa: ANN001, ANN202
    """Day-1 forecast of the ACTIVE model: its verified artifact (ML) or its baseline rule."""
    from app.pipeline import BASELINE_FUNCS  # late import: pipeline calls this module

    if active.identity.name in BASELINE_FUNCS:
        rule = BASELINE_FUNCS[active.identity.name]
        return lambda builder, origin: rule(hist.y, origin, 1)[:, 0]
    loaded = artifacts.load_artifact(
        active.identity, feature_names=FeatureBuilder(hist).feature_names, horizon=1
    )
    if loaded.model is None:
        raise artifacts.ArtifactError("The ACTIVE ML artifact has no estimator.")
    model = loaded.model
    return lambda builder, origin: np.clip(model.predict(builder.features(origin, 1)), 0.0, None)


def run_monitoring(trigger: str, forecast_run_id: str | None = None) -> str:
    """Compute and store one monitoring run; returns its id."""
    try:
        with connect(read_only=True) as conn:
            hist = load_history(conn)
            active = store.active_model(conn)
            codes = store.store_codes(conn)
            points = store.kept_points(conn)
            backtest = store.backtest_test_wape(conn, active.identity.name) if active else None
        if active is None or active.training_end is None or hist.n_days == 0:
            outcome = _nothing_to_monitor(hist, active)
        else:
            outcome = compute(
                hist,
                active.training_end,
                active.identity.name,
                _predictor(active, hist),
                points,
                backtest,
                codes,
            )
        with connect() as conn:
            run_id = store.save(conn, trigger, forecast_run_id, active, outcome, hist.days)
            conn.commit()
        return run_id
    except Exception as exc:
        with connect() as conn:
            run_id = store.save_failed(
                conn, trigger, forecast_run_id, f"{type(exc).__name__}: {exc}"
            )
            conn.commit()
        return run_id


def _nothing_to_monitor(hist, active: store.ActiveModel | None) -> MonitoringOutcome:  # noqa: ANN001
    """No ACTIVE model with a training window yet: every check is INSUFFICIENT_DATA."""
    if hist.n_days == 0:
        raise ValueError("No demand history to monitor.")
    last = hist.days[-1].astype("datetime64[D]").item()
    w = windows_for(hist, last)
    return MonitoringOutcome(w, [], "INSUFFICIENT_DATA", "INSUFFICIENT_DATA", "INSUFFICIENT_DATA")
