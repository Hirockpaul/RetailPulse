"""Generate synthetic sales history:  python -m app.synthetic [--days 365] [--seed 42]

Writes fictional daily sales for every active product × store into forecast.demand_daily,
replacing earlier synthetic rows. Real sales (source = LEDGER) are left alone.
"""

from __future__ import annotations

import argparse
from datetime import UTC, datetime, timedelta

from app.db import connect
from app.synthetic.generator import generate_history
from app.synthetic.load import read_catalog, replace_synthetic


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=365, help="days of history (default 365)")
    parser.add_argument("--seed", type=int, default=42, help="random seed (default 42)")
    args = parser.parse_args()
    if not 60 <= args.days <= 1500:
        parser.error("--days must be between 60 and 1500")

    yesterday = (datetime.now(UTC) - timedelta(days=1)).date()
    with connect() as conn:
        products, stores = read_catalog(conn)
        if products.empty or stores.empty:
            raise SystemExit("No products or stores found. Run `npm run db:seed` first.")
        history = generate_history(products, stores, yesterday, days=args.days, seed=args.seed)
        rows = replace_synthetic(conn, history)
    print(
        f"Generated {rows:,} rows of SYNTHETIC daily sales: {len(products)} products x "
        f"{len(stores)} stores, {history['day'].min()} to {history['day'].max()} (seed {args.seed}). "
        "This data is fictional."
    )


if __name__ == "__main__":
    main()
