"""Explanations of the machine-learning forecast (SHAP, TreeExplainer). V2 step 1c.

What is explained: the model's forecast for the FIRST forecast day (horizon day 1 = the day
after the history ends) of every product at every
store, plus which features the model relies on most overall (mean |contribution| over days 1-7).

How to read it. The model predicts the log of the expected units (Poisson loss), and SHAP splits
that log value exactly into a starting point plus one contribution per feature:

    log(forecast) = base + c_1 + c_2 + ... + c_k       (checked to 1e-6 before anything is saved)
    forecast      = exp(base) × exp(c_1) × ... × exp(c_k)

so every feature is a FACTOR: "the last 7 days' average multiplies the forecast by 1.4". The
starting point exp(base) is the model's typical forecast over its training data.

These are contributions to the MODEL'S forecast, not causes of real demand: a large factor means
the model leaned on that input, not that the input made customers buy.

If the decomposition does not add up (for example a future SHAP version behaving differently),
nothing is stored and the run says so — a wrong explanation is worse than none.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import shap
from sklearn.ensemble import HistGradientBoostingRegressor

from app.models.ml import FeatureBuilder

ADDITIVITY_TOLERANCE = 1e-6
GLOBAL_HORIZON_DAYS = 7  # global importance is measured over the scored horizon (1-7 days)
# Model columns shown as ONE factor (contributions add, so the decomposition stays exact).
# "season" is the time of year; its value is the target day's day of the year.
GROUPS = {"season": ("season_sin", "season_cos")}


class NotAdditive(Exception):
    """SHAP values did not add up to the model output; explanations would be wrong."""


@dataclass
class Explanations:
    feature_names: list[str]
    base_log: float  # starting point, in log units
    values: np.ndarray  # (series, features) feature values for the first forecast day
    contributions: np.ndarray  # (series, features) SHAP values, log units
    forecast: np.ndarray  # (series,) the model's forecast for that day, units
    global_importance: np.ndarray  # (features,) mean |contribution| over days 1-7, log units


def explain(
    model: HistGradientBoostingRegressor, builder: FeatureBuilder, origin: int
) -> Explanations:
    """Explain the forecasts made at `origin` (the last known day)."""
    explainer = shap.TreeExplainer(model)
    base = float(np.ravel(explainer.expected_value)[0])

    def contributions(x: np.ndarray) -> np.ndarray:
        phi = np.asarray(explainer.shap_values(x))
        gap = np.max(np.abs(phi.sum(axis=1) + base - np.log(model.predict(x))))
        if not gap <= ADDITIVITY_TOLERANCE:
            raise NotAdditive(f"SHAP values miss the model output by {gap:.2e} (log units)")
        return phi

    names = builder.feature_names
    x1 = builder.features(origin, 1)
    phi1 = contributions(x1)
    everything = np.vstack(
        [contributions(builder.features(origin, h)) for h in range(2, GLOBAL_HORIZON_DAYS + 1)]
        + [phi1]
    )
    target = builder.day0 + np.timedelta64(origin + 1, "D")
    day_of_year = float((target - target.astype("datetime64[Y]")).astype(int) + 1)
    out_names, merge = _grouping(names)
    values = np.column_stack(
        [
            x1[:, cols[0]] if name not in GROUPS else np.full(len(x1), day_of_year)
            for name, cols in zip(out_names, merge, strict=True)
        ]
    )
    grouped1 = np.column_stack([phi1[:, cols].sum(axis=1) for cols in merge])
    grouped_all = np.column_stack([everything[:, cols].sum(axis=1) for cols in merge])
    return Explanations(
        feature_names=out_names,
        base_log=base,
        values=values,
        contributions=grouped1,
        forecast=model.predict(x1),
        global_importance=np.mean(np.abs(grouped_all), axis=0),
    )


def _grouping(names: list[str]) -> tuple[list[str], list[list[int]]]:
    """Output feature names and, for each, the model columns whose contributions it sums."""
    out, merge, used = [], [], set()
    for i, name in enumerate(names):
        if i in used:
            continue
        group = next((g for g, members in GROUPS.items() if name in members), None)
        if group is None:
            out.append(name)
            merge.append([i])
        else:
            cols = [names.index(m) for m in GROUPS[group] if m in names]
            used.update(cols)
            out.append(group)
            merge.append(cols)
    return out, merge
