"""RetailPulse forecasting service.

Day 1: health endpoint only. Day 6 adds the synthetic history generator,
baseline models (moving average, seasonal naive), backtesting and forecast APIs.
Forecasts are advisory: this service never mutates inventory or places orders.
"""

from datetime import UTC, datetime

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="RetailPulse Forecasting", version="0.1.0")


class Health(BaseModel):
    status: str
    service: str
    checked_at: datetime


@app.get("/health", response_model=Health)
def health() -> Health:
    return Health(status="ok", service="retailpulse-forecasting", checked_at=datetime.now(UTC))
