"""Reproducible accuracy measurement:  python -m app.evaluation.report  (npm run forecast:measure)

Rebuilds the SAME synthetic history the dev database gets (`npm run forecast:history`: the real
catalog, 365 days, seed 42, default anomaly share) in memory, runs the full evaluation for a few
feature configurations, and prints validation/test WAPE, bias, 80 % range coverage and width,
per-horizon WAPE, and the noise floor (a forecast that knows the TRUE expected demand — only
possible because the data is synthetic). Reads the catalog only; writes nothing.
"""

from __future__ import annotations

import argparse
import time
import warnings
from datetime import UTC, datetime, timedelta

import numpy as np
import pandas as pd

from app.data import build_history
from app.db import connect
from app.evaluation.backtest import make_windows
from app.evaluation.metrics import wape
from app.models import ml
from app.pipeline import compute
from app.synthetic.generator import ANOMALY_SHARE, generate, simulate
from app.synthetic.load import read_catalog

CONFIGS = {
    "Day 6 encoding (native categorical, no promotions)": ml.FeatureConfig("native", False),
    "codes + promotion calendar": ml.FeatureConfig("codes", True),
    "one-hot + promotion calendar": ml.FeatureConfig("onehot", True),
}


def pct(x: float) -> str:
    return "   —  " if not np.isfinite(x) else f"{100 * x:5.1f}%"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=365)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--anomaly-share", type=float, default=ANOMALY_SHARE)
    parser.add_argument(
        "--candidates",
        action="store_true",
        help="compare candidate ML models (V2 step 1d) instead of feature configurations",
    )
    args = parser.parse_args()

    end = (datetime.now(UTC) - timedelta(days=1)).date()
    with connect(read_only=True) as conn:
        products, stores = read_catalog(conn)
    data = generate(products, stores, end, args.days, args.seed, anomaly_share=args.anomaly_share)
    pairs = pd.DataFrame(
        [
            (p, s, c)
            for p, c in zip(products.product_id, products.category, strict=True)
            for s in stores.location_id
        ],
        columns=["product_id", "location_id", "category_id"],
    )
    hist = build_history(pairs, data.demand, {"SYNTHETIC"}, data.promotions)

    # Noise floor: WAPE of the TRUE expected demand on the test window (same series as the models).
    sim = simulate(products, stores, end, args.days, args.seed, anomaly_share=args.anomaly_share)
    lam = sim["lam"].reshape(hist.n_series, -1)
    w = make_windows(hist.n_days)
    eligible = hist.start_idx <= (w.val_start - 1) - (ml.MIN_HISTORY_FOR_FEATURES - 1)
    actual = hist.y[:, w.test_start : w.test_end]
    mask = eligible[:, None] & np.isfinite(actual)
    floor = wape(actual[mask], lam[:, w.test_start : w.test_end][mask])

    print(
        f"SYNTHETIC data: {len(products)} products x {len(stores)} stores, {args.days} days, "
        f"seed {args.seed}, {len(data.promotions):,} promotion days, "
        f"{(data.anomalies.kind == 'SPIKE').sum()} spikes + "
        f"{(data.anomalies.kind == 'DROP').sum()} drop days injected; "
        f"{int(eligible.sum())} of {hist.n_series} series scored, test = last 28 days, 1-7 days ahead."
    )
    print(f"Noise floor (knows the true expected demand): test WAPE {pct(floor)}\n")

    if args.candidates:
        compare_candidates(hist)
        return

    header = (
        f"{'model':20} {'val WAPE':>9} {'test WAPE':>9} {'bias':>7} {'80% cover':>9} {'width':>6}"
    )
    for label, config in CONFIGS.items():
        started = time.perf_counter()
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            out = compute(hist, 14, args.seed, config)
        seconds = time.perf_counter() - started
        print(f"== {label}   ({seconds:.0f} s; served: {out.selection.model})")
        print(header)
        for model, m in out.metrics.items():
            v, t = m["validation"], m["test"]
            print(
                f"{model:20} {pct(v['wape']):>9} {pct(t['wape']):>9} {pct(t['bias']):>7} "
                f"{pct(t['interval_coverage']):>9} {t['interval_width']:6.2f}"
            )
        by_h = [
            pct(h["wape"]).strip()
            for h in out.horizon_metrics
            if h["model"] == ml_name() and h["split"] == "test"
        ]
        print(f"{ml_name()} test WAPE by days ahead (1..7): {' '.join(by_h)}\n")


def compare_candidates(hist) -> None:
    from app.evaluation.compare import CANDIDATES, decide, evaluate

    print("Candidate models, same protocol as production (decision rule: docs/V2-PLAN.md 1d)\n")
    print(
        f"{'candidate':36} {'val WAPE':>9} {'test WAPE':>9} {'val MAE':>8} {'test bias':>9} "
        f"{'80% cover':>9} {'time':>6}"
    )
    results = []
    for name, (trainer, seed) in CANDIDATES.items():
        r = evaluate(hist, name, trainer, seed)
        results.append(r)
        print(
            f"{name:36} {pct(r.validation['wape']):>9} {pct(r.test['wape']):>9} "
            f"{r.validation['mae']:8.3f} {pct(r.test['bias']):>9} "
            f"{pct(r.test['interval_coverage']):>9} {r.seconds:5.0f}s",
            flush=True,
        )
    production, noise = results[0], results[1]
    print(
        "\nSeed-to-seed difference of hgb_direct on validation: "
        f"{100 * abs(production.validation['wape'] - noise.validation['wape']):.2f} points"
    )
    for candidate in results[2:]:
        print(decide(production, candidate))


def ml_name() -> str:
    from app.evaluation.backtest import ML_MODEL

    return ML_MODEL


if __name__ == "__main__":
    main()
