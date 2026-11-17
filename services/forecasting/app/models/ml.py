"""The machine-learning model: one global gradient-boosting model for all series.

It is a *direct multi-horizon* model: for a forecast origin (the last known day) and a horizon
h = 1..H it predicts the units sold on day origin + h. Every feature is computed from data up to
and including the origin only, so the model never sees the future (tested in test_ml.py).
"""

from __future__ import annotations

import numpy as np
from sklearn.ensemble import HistGradientBoostingRegressor

from app.data import History

FEATURES = [
    "mean_7d",
    "mean_28d",
    "mean_56d",
    "std_28d",
    "last_same_weekday",
    "mean_4_same_weekdays",
    "ratio_7d_28d",
    "weekday",
    "horizon",
    "season_sin",
    "season_cos",
    "category",
    "store",
]
CATEGORICAL = [FEATURES.index(name) for name in ("weekday", "category", "store")]
MIN_HISTORY_FOR_FEATURES = 28  # observed days a series needs before an origin to be a training row


class FeatureBuilder:
    def __init__(self, hist: History) -> None:
        y = hist.y
        finite = np.isfinite(y)
        yz = np.where(finite, y, 0.0)
        zero = np.zeros((y.shape[0], 1))
        self.yz = yz
        self.finite = finite
        self.cs = np.concatenate([zero, np.cumsum(yz, axis=1)], axis=1)
        self.cs2 = np.concatenate([zero, np.cumsum(yz**2, axis=1)], axis=1)
        self.cnt = np.concatenate([zero, np.cumsum(finite, axis=1)], axis=1)
        self.start = hist.start_idx
        self.category = hist.category.astype(float)
        self.store = hist.store.astype(float)
        self.day0 = hist.days[0]
        self.n_days = hist.n_days

    def _window(self, origin: int, width: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        lo = max(origin + 1 - width, 0)
        total = self.cs[:, origin + 1] - self.cs[:, lo]
        total2 = self.cs2[:, origin + 1] - self.cs2[:, lo]
        count = np.maximum(self.cnt[:, origin + 1] - self.cnt[:, lo], 1)
        mean = total / count
        return mean, np.sqrt(np.maximum(total2 / count - mean**2, 0.0)), count

    def features(self, origin: int, horizon_day: int) -> np.ndarray:
        """Feature matrix (series x features) for forecasting `horizon_day` days after `origin`."""
        mean7, _, _ = self._window(origin, 7)
        mean28, std28, _ = self._window(origin, 28)
        mean56, _, _ = self._window(origin, 56)

        weeks_back = -(-horizon_day // 7)
        newest = origin + horizon_day - 7 * weeks_back  # latest known day with the target's weekday
        last_same = self.yz[:, newest] if newest >= 0 else np.zeros(self.yz.shape[0])
        total = np.zeros(self.yz.shape[0])
        count = np.zeros(self.yz.shape[0])
        for j in range(4):
            idx = newest - 7 * j
            if idx >= 0:
                total += self.yz[:, idx]
                count += self.finite[:, idx]
        mean4 = total / np.maximum(count, 1)

        target = self.day0 + np.timedelta64(origin + horizon_day, "D")
        weekday = (int(target.astype(int)) + 3) % 7  # 1970-01-01 was a Thursday; Monday = 0
        day_of_year = int((target - target.astype("datetime64[Y]")).astype(int)) + 1
        angle = 2 * np.pi * day_of_year / 365.25
        n = self.yz.shape[0]
        columns = [
            mean7,
            mean28,
            mean56,
            std28,
            last_same,
            mean4,
            mean7 / (mean28 + 0.1),
            np.full(n, weekday),
            np.full(n, horizon_day),
            np.full(n, np.sin(angle)),
            np.full(n, np.cos(angle)),
            self.category,
            self.store,
        ]
        return np.column_stack(columns)

    def training_set(
        self,
        train_end: int,
        horizon: int,
        rng: np.random.Generator,
        step: int = 7,
        max_rows: int = 450_000,
    ) -> tuple[np.ndarray, np.ndarray]:
        """Rows whose features AND target lie at or before day index `train_end` (inclusive)."""
        xs, ys = [], []
        for origin in range(train_end - 1, MIN_HISTORY_FOR_FEATURES - 1, -step):
            for h in range(1, horizon + 1):
                target_idx = origin + h
                if target_idx > train_end:
                    break
                ok = (origin - self.start >= MIN_HISTORY_FOR_FEATURES - 1) & self.finite[
                    :, target_idx
                ]
                if not ok.any():
                    continue
                xs.append(self.features(origin, h)[ok])
                ys.append(self.yz[ok, target_idx])
        if not xs:
            raise ValueError("Not enough history to train the model.")
        x, y = np.vstack(xs), np.concatenate(ys)
        if len(y) > max_rows:
            keep = rng.choice(len(y), max_rows, replace=False)
            x, y = x[keep], y[keep]
        return x, y


def train(
    builder: FeatureBuilder, train_end: int, horizon: int, seed: int = 42
) -> HistGradientBoostingRegressor:
    rng = np.random.default_rng(seed)
    x, y = builder.training_set(train_end, horizon, rng)
    model = HistGradientBoostingRegressor(
        loss="poisson",
        learning_rate=0.08,
        max_iter=200,
        max_leaf_nodes=31,
        min_samples_leaf=200,
        l2_regularization=1.0,
        categorical_features=CATEGORICAL,
        random_state=seed,
    )
    model.fit(x, y)
    return model


def predict(
    model: HistGradientBoostingRegressor, builder: FeatureBuilder, origin: int, horizon: int
) -> np.ndarray:
    """(series x horizon) forecast using only data up to `origin`."""
    out = np.zeros((builder.yz.shape[0], horizon))
    for h in range(1, horizon + 1):
        out[:, h - 1] = model.predict(builder.features(origin, h))
    return np.clip(out, 0.0, None)
