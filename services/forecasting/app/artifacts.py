"""Write-once model bundles and safe, verified loading from the service-owned artifact root."""

from __future__ import annotations

import hashlib
import hmac
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import joblib
from sklearn.ensemble import HistGradientBoostingRegressor

from app.config import PIPELINE_VERSION, model_artifact_dir

SCHEMA_VERSION = 1


class ArtifactError(RuntimeError):
    """The registered artifact is missing, unsafe, corrupt or incompatible."""


@dataclass(frozen=True)
class ModelIdentity:
    id: str
    name: str
    version: str
    kind: str
    artifact_path: str | None = None
    artifact_sha256: str | None = None
    artifact_schema_version: int | None = None


@dataclass(frozen=True)
class StoredArtifact:
    path: str
    sha256: str
    schema_version: int = SCHEMA_VERSION


@dataclass(frozen=True)
class LoadedArtifact:
    model: HistGradientBoostingRegressor | None
    feature_names: list[str]
    max_horizon: int
    local_path: Path


def _digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def _safe_path(relative_path: str, *, must_exist: bool) -> Path:
    raw = Path(relative_path)
    if raw.is_absolute() or ".." in raw.parts:
        raise ArtifactError("Artifact path must be relative and cannot contain '..'.")
    root = model_artifact_dir()
    candidate = root.joinpath(raw)
    cursor = root
    for part in raw.parts:
        cursor = cursor / part
        if cursor.is_symlink():
            raise ArtifactError("Artifact path cannot contain symlinks.")
    try:
        resolved = candidate.resolve(strict=must_exist)
        resolved.relative_to(root)
    except (FileNotFoundError, RuntimeError, ValueError) as exc:
        raise ArtifactError("Artifact path does not resolve to a file under MODEL_ARTIFACT_DIR.") from exc
    if must_exist and not resolved.is_file():
        raise ArtifactError("Artifact path must identify a regular, non-symlink file.")
    return resolved


def write_artifact(
    identity: ModelIdentity,
    *,
    params: dict[str, Any],
    feature_names: list[str],
    max_horizon: int,
    model: HistGradientBoostingRegressor | None,
) -> StoredArtifact:
    """Serialize once, name by content digest, and never replace an existing artifact."""
    if identity.kind == "ML" and not isinstance(model, HistGradientBoostingRegressor):
        raise ArtifactError("An ML artifact requires a fitted HistGradientBoostingRegressor.")
    if identity.kind != "ML" and model is not None:
        raise ArtifactError("A baseline artifact must not contain an estimator.")
    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "modelId": identity.id,
        "modelName": identity.name,
        "modelVersion": identity.version,
        "kind": identity.kind,
        "pipelineVersion": PIPELINE_VERSION,
        "featureNames": list(feature_names),
        "maxHorizon": int(max_horizon),
        "params": params,
        "model": model,
    }
    root = model_artifact_dir()
    root.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix="artifact-", suffix=".joblib", dir=root)
    temp_path = Path(temporary)
    try:
        os.close(fd)
        joblib.dump(payload, temp_path, compress=3)
        sha256 = _digest(temp_path)
        relative = Path(identity.name) / identity.version / f"{identity.id}-{sha256}.joblib"
        final_path = _safe_path(relative.as_posix(), must_exist=False)
        final_path.parent.mkdir(parents=True, exist_ok=True)
        if final_path.exists():
            if not hmac.compare_digest(_digest(final_path), sha256):
                raise ArtifactError("Existing content-addressed artifact has a different digest.")
            temp_path.unlink()
        else:
            os.replace(temp_path, final_path)
            final_path.chmod(0o440)
        stored = StoredArtifact(relative.as_posix(), sha256)
        # A write is not accepted until the exact bytes pass the normal guarded load path.
        load_artifact(identity, stored, feature_names=feature_names, horizon=max_horizon)
        return stored
    finally:
        temp_path.unlink(missing_ok=True)


def load_artifact(
    identity: ModelIdentity,
    stored: StoredArtifact | None = None,
    *,
    feature_names: list[str] | None = None,
    horizon: int | None = None,
) -> LoadedArtifact:
    path = stored.path if stored else identity.artifact_path
    sha256 = stored.sha256 if stored else identity.artifact_sha256
    schema = stored.schema_version if stored else identity.artifact_schema_version
    if not path or not sha256 or schema is None:
        raise ArtifactError(f"ACTIVE model {identity.name} has no registered artifact.")
    if schema != SCHEMA_VERSION:
        raise ArtifactError(f"Unsupported artifact schema version {schema}.")
    local_path = _safe_path(path, must_exist=True)
    actual = _digest(local_path)
    if not hmac.compare_digest(actual, sha256):
        raise ArtifactError(f"Artifact SHA-256 mismatch for ACTIVE model {identity.name}.")
    # Deserialization happens only after path and digest validation.
    try:
        payload = joblib.load(local_path)
    except Exception as exc:
        raise ArtifactError("Verified artifact bytes could not be deserialized.") from exc
    expected = {
        "schemaVersion": SCHEMA_VERSION,
        "modelId": identity.id,
        "modelName": identity.name,
        "modelVersion": identity.version,
        "kind": identity.kind,
        "pipelineVersion": PIPELINE_VERSION,
    }
    if not isinstance(payload, dict) or any(payload.get(key) != value for key, value in expected.items()):
        raise ArtifactError("Artifact identity or pipeline metadata does not match the registry.")
    names = payload.get("featureNames")
    max_horizon = payload.get("maxHorizon")
    if not isinstance(names, list) or not all(isinstance(name, str) for name in names):
        raise ArtifactError("Artifact feature metadata is invalid.")
    if not isinstance(max_horizon, int) or max_horizon < 1:
        raise ArtifactError("Artifact horizon metadata is invalid.")
    if feature_names is not None and names != feature_names:
        raise ArtifactError("Artifact feature order does not match the running pipeline.")
    if horizon is not None and horizon > max_horizon:
        raise ArtifactError(
            f"Artifact supports at most {max_horizon} forecast days, but {horizon} were requested."
        )
    model = payload.get("model")
    if identity.kind == "ML" and not isinstance(model, HistGradientBoostingRegressor):
        raise ArtifactError("ML artifact does not contain the expected estimator type.")
    if identity.kind != "ML" and model is not None:
        raise ArtifactError("Baseline artifact unexpectedly contains an estimator.")
    return LoadedArtifact(model, names, max_horizon, local_path)
