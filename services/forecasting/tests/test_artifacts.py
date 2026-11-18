from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from sklearn.ensemble import HistGradientBoostingRegressor

from app import artifacts


def fitted_model() -> HistGradientBoostingRegressor:
    x = np.arange(80, dtype=float).reshape(40, 2)
    y = np.arange(40, dtype=float) + 1
    return HistGradientBoostingRegressor(loss="poisson", random_state=4).fit(x, y)


def identity(**changes) -> artifacts.ModelIdentity:
    values = {
        "id": "11111111-1111-4111-8111-111111111111",
        "name": "hgb_direct",
        "version": "2",
        "kind": "ML",
    }
    values.update(changes)
    return artifacts.ModelIdentity(**values)


def test_artifact_round_trip_is_content_addressed_and_deterministic(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MODEL_ARTIFACT_DIR", str(tmp_path))
    model = fitted_model()
    first = artifacts.write_artifact(
        identity(),
        params={"loss": "poisson"},
        feature_names=["a", "b"],
        max_horizon=14,
        model=model,
    )
    second = artifacts.write_artifact(
        identity(),
        params={"loss": "poisson"},
        feature_names=["a", "b"],
        max_horizon=14,
        model=model,
    )
    assert first == second
    loaded = artifacts.load_artifact(
        identity(
            artifact_path=first.path,
            artifact_sha256=first.sha256,
            artifact_schema_version=first.schema_version,
        ),
        feature_names=["a", "b"],
        horizon=14,
    )
    assert loaded.local_path.is_file()
    assert np.allclose(loaded.model.predict([[2.0, 3.0]]), model.predict([[2.0, 3.0]]))


def test_tamper_is_rejected_before_deserialization(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MODEL_ARTIFACT_DIR", str(tmp_path))
    stored = artifacts.write_artifact(
        identity(), params={}, feature_names=["a", "b"], max_horizon=7, model=fitted_model()
    )
    path = tmp_path / stored.path
    path.chmod(0o640)
    path.write_bytes(path.read_bytes() + b"tampered")
    called = False

    def unexpected_load(_path):
        nonlocal called
        called = True
        raise AssertionError("joblib.load must not run for unverified bytes")

    monkeypatch.setattr(artifacts.joblib, "load", unexpected_load)
    with pytest.raises(artifacts.ArtifactError, match="SHA-256 mismatch"):
        artifacts.load_artifact(
            identity(
                artifact_path=stored.path,
                artifact_sha256=stored.sha256,
                artifact_schema_version=stored.schema_version,
            )
        )
    assert called is False


def test_traversal_metadata_and_horizon_mismatches_are_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MODEL_ARTIFACT_DIR", str(tmp_path))
    with pytest.raises(artifacts.ArtifactError, match="relative"):
        artifacts.load_artifact(
            identity(
                artifact_path="../outside.joblib",
                artifact_sha256="a" * 64,
                artifact_schema_version=1,
            )
        )
    outside = tmp_path.parent / "outside.joblib"
    outside.write_bytes(b"not an artifact")
    (tmp_path / "linked.joblib").symlink_to(outside)
    with pytest.raises(artifacts.ArtifactError, match="symlinks"):
        artifacts.load_artifact(
            identity(
                artifact_path="linked.joblib",
                artifact_sha256="a" * 64,
                artifact_schema_version=1,
            )
        )
    stored = artifacts.write_artifact(
        identity(), params={}, feature_names=["a", "b"], max_horizon=7, model=fitted_model()
    )
    with pytest.raises(artifacts.ArtifactError, match="identity"):
        artifacts.load_artifact(
            identity(
                id="22222222-2222-4222-8222-222222222222",
                artifact_path=stored.path,
                artifact_sha256=stored.sha256,
                artifact_schema_version=1,
            )
        )
    with pytest.raises(artifacts.ArtifactError, match="at most 7"):
        artifacts.load_artifact(
            identity(
                artifact_path=stored.path,
                artifact_sha256=stored.sha256,
                artifact_schema_version=1,
            ),
            feature_names=["a", "b"],
            horizon=8,
        )
