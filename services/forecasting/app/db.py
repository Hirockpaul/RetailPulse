"""Database connections.

Reads (history, catalog, balances) use a READ ONLY connection. Writes go through a separate
connection and the repository only ever writes to the `forecast` schema: a forecast must never
change inventory or create orders (checked by tests/test_write_guard.py).
"""

from __future__ import annotations

import psycopg

from app.config import database_url


def connect(*, read_only: bool = False) -> psycopg.Connection:
    conn = psycopg.connect(database_url(), autocommit=False)
    if read_only:
        conn.read_only = True
    return conn
