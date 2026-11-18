"""Optional OpenTelemetry setup and safe request correlation for the internal service."""

from __future__ import annotations

import os
import re
import secrets
from collections.abc import Awaitable, Callable

from fastapi import FastAPI, Request, Response
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.sdk.resources import SERVICE_NAME, Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

SAFE_ID = re.compile(r"^[A-Za-z0-9._-]{8,64}$")


def traces_endpoint(value: str | None) -> str | None:
    endpoint = (value or "").strip().rstrip("/")
    if not endpoint:
        return None
    return endpoint if endpoint.endswith("/v1/traces") else f"{endpoint}/v1/traces"


async def correlate_request(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    incoming = request.headers.get("x-correlation-id", "")
    correlation_id = incoming if SAFE_ID.fullmatch(incoming) else secrets.token_hex(16)
    span = trace.get_current_span()
    span_context = span.get_span_context()
    if span_context.is_valid:
        span.set_attribute("retailpulse.correlation_id", correlation_id)
    response = await call_next(request)
    response.headers["x-correlation-id"] = correlation_id
    if span_context.is_valid:
        response.headers["x-trace-id"] = trace.format_trace_id(span_context.trace_id)
    return response


def configure_tracing(app: FastAPI) -> bool:
    """Instrument requests always for W3C propagation; export only when explicitly configured."""
    endpoint = traces_endpoint(os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"))
    provider: TracerProvider | None = None
    if endpoint:
        provider = TracerProvider(resource=Resource.create({SERVICE_NAME: "retailpulse-forecasting"}))
        provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint)))
        trace.set_tracer_provider(provider)
    app.middleware("http")(correlate_request)
    FastAPIInstrumentor.instrument_app(app, tracer_provider=provider)
    return endpoint is not None
