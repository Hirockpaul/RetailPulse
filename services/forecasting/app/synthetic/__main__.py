"""Generate synthetic sales history:  python -m app.synthetic [--days 365] [--seed 42]
                                                           [--anomaly-share 0.12]

Writes fictional daily sales for every active product × store into forecast.demand_daily, plus
the promotion calendar (forecast.promotions) and labelled injected anomalies
(forecast.injected_anomalies), replacing earlier synthetic rows. Real sales (source = LEDGER)
are left alone.
"""

from __future__ import annotations

import argparse
from datetime import UTC, datetime, timedelta

from app.db import connect
from app.synthetic.generator import ANOMALY_SHARE, generate
from app.synthetic.load import read_catalog, replace_synthetic


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=365, help="days of history (default 365)")
    parser.add_argument("--seed", type=int, default=42, help="random seed (default 42)")
    parser.add_argument(
        "--anomaly-share",
        type=float,
        default=ANOMALY_SHARE,
        help=f"share of series given one labelled anomaly (default {ANOMALY_SHARE}; 0 = none)",
    )
    args = parser.parse_args()
    if not 60 <= args.days <= 1500:
        parser.error("--days must be between 60 and 1500")
    if not 0 <= args.anomaly_share <= 1:
        parser.error("--anomaly-share must be between 0 and 1")

    yesterday = (datetime.now(UTC) - timedelta(days=1)).date()
    with connect() as conn:
        products, stores = read_catalog(conn)
        if products.empty or stores.empty:
            raise SystemExit("No products or stores found. Run `npm run db:seed` first.")
        data = generate(
            products,
            stores,
            yesterday,
            days=args.days,
            seed=args.seed,
            anomaly_share=args.anomaly_share,
        )
        rows = replace_synthetic(conn, data.demand, data.promotions, data.anomalies)
    history, anomalies = data.demand, data.anomalies
    print(
        f"Generated {rows:,} rows of SYNTHETIC daily sales: {len(products)} products x "
        f"{len(stores)} stores, {history['day'].min()} to {history['day'].max()} (seed {args.seed}). "
        f"Promotion days: {len(data.promotions):,}. Injected anomalies: "
        f"{(anomalies['kind'] == 'SPIKE').sum()} spikes, "
        f"{(anomalies['kind'] == 'DROP').sum()} drop days. This data is fictional."
    )


if __name__ == "__main__":
    main()
