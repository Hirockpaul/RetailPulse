from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from app.config import DEFAULT_HORIZON_DAYS


class ApiModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class RunRequest(ApiModel):
    horizon_days: int = Field(default=DEFAULT_HORIZON_DAYS, ge=1, le=28)


class RunStarted(ApiModel):
    run_id: str
    status: str
