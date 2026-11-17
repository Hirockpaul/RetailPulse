"""A forecast must never change inventory or create orders.

Every statement in the service that WRITES (INSERT / UPDATE / DELETE / TRUNCATE / COPY ... FROM)
must target the `forecast` schema. Reads may touch anything.
"""

import re
from pathlib import Path

APP = Path(__file__).resolve().parents[1] / "app"
WRITE = re.compile(
    r"\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|COPY)\s+([A-Za-z_][\w.]*)",
    re.IGNORECASE,
)
# SQL keywords that follow "UPDATE"/"COPY" in prose or Python, not table names.
NOT_TABLES = {"set", "the", "a", "of", "to", "from"}


def sql_strings(source: str) -> list[str]:
    return re.findall(r'"""(.*?)"""|"([^"\n]*)"', source, flags=re.DOTALL)  # type: ignore[return-value]


def write_targets() -> list[tuple[str, str]]:
    found = []
    for path in sorted(APP.rglob("*.py")):
        text = path.read_text(encoding="utf-8")
        for match in WRITE.finditer(text):
            target = match.group(1)
            if target.lower() in NOT_TABLES:
                continue
            found.append((path.name, target))
    return found


def test_the_service_has_writes_and_every_one_targets_the_forecast_schema() -> None:
    targets = write_targets()
    assert len(targets) >= 8  # the scan really found the statements
    offenders = [(f, t) for f, t in targets if not t.lower().startswith("forecast.")]
    assert offenders == [], f"writes outside the forecast schema: {offenders}"


def test_nothing_touches_inventory_or_order_tables_for_writing() -> None:
    forbidden = (
        "inventory_ledger",
        "inventory_balances",
        "stock_transfers",
        "purchase_orders",
        "replenishment_recommendations",
        "sales_orders",
        "reservations",
    )
    for _, target in write_targets():
        assert not any(name in target.lower() for name in forbidden)
