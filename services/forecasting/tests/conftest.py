"""Shared fixtures: a throw-away PostgreSQL database built from the real API migrations."""

from __future__ import annotations

import os
import secrets
import time
from collections.abc import Iterator
from pathlib import Path

import psycopg
import pytest

from app.config import database_url

MIGRATIONS = Path(__file__).resolve().parents[2] / "api" / "migrations"


@pytest.fixture(scope="session")
def admin_url() -> str:
    try:
        url = database_url()
        with psycopg.connect(url, connect_timeout=3):
            pass
    except Exception as exc:  # no database available: skip DB tests, run the pure ones
        pytest.skip(f"PostgreSQL not available ({type(exc).__name__})", allow_module_level=False)
    return url


@pytest.fixture()
def test_db(
    admin_url: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> Iterator[str]:
    """A fresh database with all migrations applied; DATABASE_URL points at it during the test."""
    name = f"rp_fc_{int(time.time())}_{secrets.token_hex(3)}"
    with psycopg.connect(admin_url, autocommit=True) as admin:
        admin.execute(f'CREATE DATABASE "{name}"')
    base, _, _ = admin_url.rpartition("/")
    url = f"{base}/{name}"
    with psycopg.connect(url, autocommit=True) as conn:
        for path in sorted(MIGRATIONS.glob("*.sql")):
            conn.execute(path.read_text(encoding="utf-8"))
    monkeypatch.setenv("DATABASE_URL", url)
    monkeypatch.setenv("MODEL_ARTIFACT_DIR", str(tmp_path / "model-artifacts"))
    try:
        yield url
    finally:
        with psycopg.connect(admin_url, autocommit=True) as admin:
            admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


@pytest.fixture()
def catalog(test_db: str) -> dict:
    """24 products in 3 categories, 3 stores and 1 distribution centre (all fictional)."""
    with psycopg.connect(test_db) as conn:
        cats = [
            r[0]
            for r in conn.execute(
                "INSERT INTO categories (name) VALUES ('Beverages'), ('Dairy'), ('Snacks') RETURNING id"
            ).fetchall()
        ]
        for i in range(24):
            conn.execute(
                "INSERT INTO products (sku, name, category_id, unit_price, pack_size) "
                "VALUES (%s, %s, %s, 2.50, 6)",
                (f"T-{i:04d}", f"Test product {i}", cats[i % 3]),
            )
        conn.execute(
            """INSERT INTO locations (code, name, type, city) VALUES
               ('S-1', 'Store 1', 'STORE', 'X'), ('S-2', 'Store 2', 'STORE', 'X'),
               ('S-3', 'Store 3', 'STORE', 'X'), ('DC-1', 'DC 1', 'DISTRIBUTION_CENTER', 'X')"""
        )
        conn.commit()
    os.environ.setdefault("TZ", "UTC")
    return {"url": test_db}
