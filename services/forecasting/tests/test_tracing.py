"""Trace propagation remains useful even when the optional exporter is disabled."""

from fastapi.testclient import TestClient

from app.main import app
from app.tracing import traces_endpoint


def test_exporter_is_optional_and_endpoint_is_normalized() -> None:
    assert traces_endpoint(None) is None
    assert traces_endpoint("  ") is None
    assert traces_endpoint("http://jaeger:4318/") == "http://jaeger:4318/v1/traces"
    assert traces_endpoint("http://collector/v1/traces") == "http://collector/v1/traces"


def test_w3c_trace_and_correlation_context_are_returned() -> None:
    trace_id = "0123456789abcdef0123456789abcdef"
    with TestClient(app) as client:
        response = client.get(
            "/health",
            headers={
                "traceparent": f"00-{trace_id}-0123456789abcdef-01",
                "x-correlation-id": "corr-trace-12345",
            },
        )
    assert response.headers["x-correlation-id"] == "corr-trace-12345"
    assert response.headers["x-trace-id"] == trace_id


def test_malformed_correlation_id_is_not_echoed() -> None:
    with TestClient(app) as client:
        response = client.get("/health", headers={"x-correlation-id": "cookie=secret"})
    assert response.headers["x-correlation-id"] != "cookie=secret"
