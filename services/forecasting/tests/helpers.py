from __future__ import annotations

from datetime import date

import pandas as pd

from app.data import History, build_history
from app.synthetic.generator import generate_history

END = date(2026, 6, 30)


def make_history(
    n_products: int = 16,
    n_stores: int = 2,
    days: int = 200,
    seed: int = 11,
    new_share: float = 0.15,
) -> History:
    cats = ["Beverages", "Dairy", "Snacks", "Household"]
    products = pd.DataFrame(
        {
            "product_id": [f"p{i}" for i in range(n_products)],
            "category": [cats[i % 4] for i in range(n_products)],
        }
    )
    stores = pd.DataFrame({"location_id": [f"s{i}" for i in range(n_stores)]})
    demand = generate_history(products, stores, END, days=days, seed=seed, new_share=new_share)
    pairs = pd.DataFrame(
        [
            (p.product_id, s.location_id, p.category)
            for p in products.itertuples()
            for s in stores.itertuples()
        ],
        columns=["product_id", "location_id", "category_id"],
    )
    return build_history(pairs, demand, {"SYNTHETIC"})
