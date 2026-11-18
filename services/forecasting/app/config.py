"""Settings. Reads DATABASE_URL from the environment, falling back to the repo-root .env file."""

from __future__ import annotations

import os
from pathlib import Path

PIPELINE_VERSION = "1"

# Forecast quality windows and rules (documented in docs/ARCHITECTURE.md §7).
EVAL_WINDOW_DAYS = 28  # length of the validation window and of the untouched test window
EVAL_HORIZON_DAYS = 7  # accuracy is measured 1-7 days ahead, from rolling origins
MIN_HISTORY_DAYS = 56  # fewer observed days than this -> category-average fallback
DEFAULT_HORIZON_DAYS = 14
INTERVAL_Z = 1.2816  # Day-6 normal 80% band; only used to compare (ranges: evaluation/intervals.py)
ACTIVATION_WAPE_GAIN = 0.005  # candidate must improve validation WAPE by 0.5 percentage points


def _load_dotenv() -> None:
    # The repo root is three levels up in a checkout; a container image (/app/app/config.py)
    # is shallower and gets its settings from the environment instead.
    parents = Path(__file__).resolve().parents
    candidates = [Path.cwd() / ".env"] + ([parents[3] / ".env"] if len(parents) > 3 else [])
    for candidate in candidates:
        if not candidate.is_file():
            continue
        for raw in candidate.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip("\"'"))
        return


def database_url() -> str:
    _load_dotenv()
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is not set (copy .env.example to .env).")
    return url


def model_artifact_dir() -> Path:
    _load_dotenv()
    configured = os.environ.get("MODEL_ARTIFACT_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    return (Path(__file__).resolve().parents[1] / ".artifacts" / "models").resolve()


def mlflow_tracking_uri() -> str | None:
    _load_dotenv()
    value = os.environ.get("MLFLOW_TRACKING_URI", "").strip()
    return value or None
