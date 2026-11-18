-- 0019 (V2 step 3b): immutable model artifacts and best-effort MLflow mirror status.

ALTER TABLE forecast.model_versions
  ADD COLUMN artifact_schema_version smallint,
  ADD COLUMN artifact_created_at timestamptz;

ALTER TABLE forecast.model_versions DROP CONSTRAINT model_artifact_pair;
ALTER TABLE forecast.model_versions ADD CONSTRAINT model_artifact_complete CHECK (
  (artifact_path IS NULL AND artifact_sha256 IS NULL
    AND artifact_schema_version IS NULL AND artifact_created_at IS NULL)
  OR
  (length(trim(artifact_path)) > 0
    AND artifact_path !~ '(^|/)\.\.(/|$)'
    AND artifact_sha256 ~ '^[0-9a-f]{64}$'
    AND artifact_schema_version > 0
    AND artifact_created_at IS NOT NULL)
);

CREATE FUNCTION forecast.model_artifact_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.artifact_path IS NOT NULL AND (
    NEW.artifact_path IS DISTINCT FROM OLD.artifact_path
    OR NEW.artifact_sha256 IS DISTINCT FROM OLD.artifact_sha256
    OR NEW.artifact_schema_version IS DISTINCT FROM OLD.artifact_schema_version
    OR NEW.artifact_created_at IS DISTINCT FROM OLD.artifact_created_at
  ) THEN
    RAISE EXCEPTION 'Model artifacts are immutable once registered'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER model_artifact_no_update
  BEFORE UPDATE OF artifact_path, artifact_sha256, artifact_schema_version, artifact_created_at
  ON forecast.model_versions
  FOR EACH ROW EXECUTE FUNCTION forecast.model_artifact_immutable();

CREATE TYPE forecast.mlflow_mirror_status AS ENUM ('DISABLED', 'PENDING', 'MIRRORED', 'FAILED');

ALTER TABLE forecast.runs
  ADD COLUMN mlflow_status forecast.mlflow_mirror_status NOT NULL DEFAULT 'DISABLED',
  ADD COLUMN mlflow_run_id text,
  ADD COLUMN mlflow_error text,
  ADD CONSTRAINT mlflow_mirror_shape CHECK (
    (mlflow_status = 'MIRRORED' AND length(trim(mlflow_run_id)) > 0 AND mlflow_error IS NULL)
    OR (mlflow_status = 'FAILED' AND mlflow_run_id IS NULL AND length(trim(mlflow_error)) > 0)
    OR (mlflow_status IN ('DISABLED', 'PENDING') AND mlflow_run_id IS NULL AND mlflow_error IS NULL)
  );
