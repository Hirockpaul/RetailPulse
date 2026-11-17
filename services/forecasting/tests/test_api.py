"""HTTP endpoints of the forecasting service (a real run, in the background thread)."""

import time

import pytest
from fastapi.testclient import TestClient

from app.main import app
from tests.test_db_pipeline import load_history


@pytest.fixture()
def client(catalog: dict) -> TestClient:
    load_history(catalog["url"])
    return TestClient(app)


def wait_for(client: TestClient, run_id: str, timeout: float = 90) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        run = client.get(f"/forecast/runs/{run_id}").json()
        if run["status"] != "RUNNING":
            return run
        time.sleep(0.3)
    raise AssertionError("run did not finish")


def test_health_reports_the_database(client: TestClient) -> None:
    body = client.get("/health").json()
    assert body["status"] == "ok" and body["database"] == "up"


def test_nothing_exists_before_the_first_run(client: TestClient) -> None:
    assert client.get("/forecast/runs/latest").status_code == 404
    assert client.get("/forecast/T-0000/S-1").status_code == 404
    assert client.get("/forecast/runs/not-a-uuid").status_code == 400


def test_run_in_the_background_then_read_the_forecast(client: TestClient) -> None:
    started = client.post("/forecast/run", json={"horizonDays": 7})
    assert started.status_code == 202 and started.json()["status"] == "RUNNING"
    run_id = started.json()["runId"]

    assert client.post("/forecast/run").status_code == 409  # one run at a time

    run = wait_for(client, run_id)
    assert run["status"] == "SUCCEEDED" and run["dataLabel"] == "SYNTHETIC"
    assert run["servedModel"] in {"moving_average_28", "seasonal_naive_7", "hgb_direct"}
    assert client.get("/forecast/runs/latest").json()["id"] == run_id

    forecast = client.get("/forecast/T-0001/S-1").json()
    assert forecast["runId"] == run_id and forecast["dataLabel"] == "SYNTHETIC"
    assert len(forecast["points"]) == 7
    assert [p["horizonDay"] for p in forecast["points"]] == list(range(1, 8))
    assert all(p["lower"] <= p["yhat"] <= p["upper"] for p in forecast["points"])
    assert client.get("/forecast/NOPE/S-1").status_code == 404


def test_validation_of_the_run_request(client: TestClient) -> None:
    assert client.post("/forecast/run", json={"horizonDays": 0}).status_code == 422
    assert client.post("/forecast/run", json={"horizonDays": 99}).status_code == 422
