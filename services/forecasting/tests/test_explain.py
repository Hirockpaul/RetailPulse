"""SHAP explanations of the ML forecast: exact, safe, and only for the model's own forecasts."""

import numpy as np
import pytest

from app import pipeline
from app.evaluation.backtest import Selection
from app.models import ml
from app.models.explain import NotAdditive, explain
from tests.helpers import make_history


def trained(config: ml.FeatureConfig | None = None):
    hist = make_history(n_products=24, n_stores=2, days=200)
    builder = ml.FeatureBuilder(hist, config)
    model = ml.train(builder, hist.n_days - 1, 7, seed=1)
    return hist, builder, model


def test_contributions_add_up_exactly_to_the_models_forecast() -> None:
    hist, builder, model = trained()
    ex = explain(model, builder, hist.n_days - 1)
    rebuilt = np.exp(ex.base_log + ex.contributions.sum(axis=1))
    assert np.allclose(rebuilt, ex.forecast, rtol=1e-6)
    assert np.allclose(ex.forecast, ml.predict(model, builder, hist.n_days - 1, 1)[:, 0])
    # sine + cosine of the time of year are shown as one "season" factor
    assert "season" in ex.feature_names and "season_sin" not in ex.feature_names
    assert (
        ex.contributions.shape == ex.values.shape == (hist.n_series, len(builder.feature_names) - 1)
    )
    day = int(ex.values[0, ex.feature_names.index("season")])
    target = hist.days[-1] + np.timedelta64(1, "D")
    assert day == int((target - target.astype("datetime64[Y]")).astype(int)) + 1


def test_global_importance_ranks_recent_demand_high() -> None:
    hist, builder, model = trained()
    ex = explain(model, builder, hist.n_days - 1)
    assert (ex.global_importance >= 0).all()
    top3 = [ex.feature_names[j] for j in np.argsort(-ex.global_importance)[:3]]
    # The synthetic demand is driven by each series' level, so a recent-average feature must lead.
    assert {"mean_7d", "mean_28d", "mean_56d", "mean_4_same_weekdays"} & set(top3), top3


def test_wrong_explanations_are_refused_not_stored() -> None:
    """With native categorical splits (Day 6 encoding) SHAP does not add up: explain() must refuse."""
    hist, builder, model = trained(ml.FeatureConfig(encoding="native"))
    with pytest.raises(NotAdditive):
        explain(model, builder, hist.n_days - 1)


def test_the_pipeline_explains_only_when_the_ml_model_is_served(monkeypatch) -> None:
    hist = make_history(days=200)
    out = pipeline.compute(hist, 7)
    if out.selection.model == "hgb_direct":
        assert out.explanation_status == "OK" and out.explanations is not None
    monkeypatch.setattr(
        pipeline, "select_model", lambda _: Selection("moving_average_28", False, "forced in test")
    )
    baseline = pipeline.compute(hist, 7)
    assert baseline.explanation_status == "NOT_ML" and baseline.explanations is None
