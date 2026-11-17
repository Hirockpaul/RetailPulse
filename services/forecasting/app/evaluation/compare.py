"""Compare candidate ML models on exactly the protocol the production model is judged by.

Same history, same time-ordered windows (validation, then the untouched test window), same
rolling 1-7-day-ahead origins, same eligible series, same metrics (WAPE, MAE, RMSE, bias) and the
same conformal ranges (calibrated on validation, checked on test). A candidate is trained on
data BEFORE each window only. V2 step 1d.

Used by `npm run forecast:measure -- --candidates`; it never writes anything.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass

import numpy as np
from sklearn.ensemble import RandomForestRegressor

from app.data import History
from app.evaluation import intervals
from app.evaluation.backtest import make_windows, rolling_forecast, score, score_range
from app.models import ml

Trainer = Callable[[ml.FeatureBuilder, int, int, int], object]


def train_random_forest(
    builder: ml.FeatureBuilder, train_end: int, horizon: int, seed: int = 42
) -> RandomForestRegressor:
    """The step-1d candidate, with settings fixed before measuring (docs/V2-PLAN.md, step 1d)."""
    x, y = builder.training_set(train_end, horizon, np.random.default_rng(seed))
    model = RandomForestRegressor(
        n_estimators=150,
        min_samples_leaf=50,
        max_features=0.5,
        max_samples=0.3,
        n_jobs=-1,
        random_state=seed,
    )
    model.fit(x, y)
    return model


CANDIDATES: dict[str, tuple[Trainer, int]] = {
    "hgb_direct (seed 42, production)": (ml.train, 42),
    "hgb_direct (seed 43, noise check)": (ml.train, 43),
    "random_forest": (train_random_forest, 42),
}


@dataclass
class CandidateResult:
    name: str
    validation: dict
    test: dict
    seconds: float


def evaluate(
    hist: History, name: str, trainer: Trainer, seed: int, horizon: int = 14
) -> CandidateResult:
    started = time.perf_counter()
    w = make_windows(hist.n_days)
    builder = ml.FeatureBuilder(hist)
    eligible = hist.start_idx <= (w.val_start - 1) - (ml.MIN_HISTORY_FOR_FEATURES - 1)
    spans = {"validation": (w.val_start, w.val_end), "test": (w.test_start, w.test_end)}
    results: dict[str, dict] = {}
    preds: dict[str, np.ndarray] = {}
    for split, (s, e) in spans.items():
        model = trainer(builder, s - 1, horizon, seed)  # data before the window only
        preds[split] = rolling_forecast(lambda o, h, m=model: ml.predict(m, builder, o, h), s, e)
        actual = hist.y[:, s:e]
        sc = score(actual, preds[split], eligible)
        results[split] = {k: v for k, v in sc.items() if not k.startswith("series_")}

    val_actual = hist.y[:, w.val_start : w.val_end]
    test_actual = hist.y[:, w.test_start : w.test_end]
    cal = intervals.calibrate(
        preds["validation"], val_actual, eligible[:, None] & np.isfinite(val_actual)
    )
    lower, upper = intervals.apply(cal, preds["test"], 80)
    coverage, width = score_range(
        test_actual, lower, upper, eligible[:, None] & np.isfinite(test_actual)
    )
    results["test"].update({"interval_coverage": coverage, "interval_width": width})
    return CandidateResult(
        name, results["validation"], results["test"], time.perf_counter() - started
    )


def decide(production: CandidateResult, candidate: CandidateResult, margin: float = 0.005) -> str:
    """The pre-registered rule (docs/V2-PLAN.md step 1d): the candidate joins production selection
    only if its VALIDATION WAPE is at least `margin` (0.5 points) lower. Test is never used."""
    gap = production.validation["wape"] - candidate.validation["wape"]
    verdict = "PASSES" if gap >= margin else "does NOT pass"
    side = "better" if gap >= 0 else "worse"
    return (
        f"{candidate.name} {verdict}: validation WAPE {100 * candidate.validation['wape']:.2f} % vs "
        f"{100 * production.validation['wape']:.2f} % — {100 * abs(gap):.2f} points {side}; "
        f"it must be at least {100 * margin:.1f} points better."
    )
