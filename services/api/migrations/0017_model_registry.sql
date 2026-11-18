-- 0017 (V2 step 3a): manager-controlled model registry and immutable activation history.
-- A run may evaluate every model, but only the one ACTIVE registry version is served.

CREATE TYPE forecast.model_status AS ENUM
  ('CANDIDATE', 'ELIGIBLE', 'ACTIVE', 'RETIRED', 'REJECTED');
CREATE TYPE forecast.activation_action AS ENUM ('BOOTSTRAP', 'ACTIVATE', 'ROLLBACK');

ALTER TABLE forecast.model_versions
  ADD COLUMN status forecast.model_status NOT NULL DEFAULT 'CANDIDATE',
  ADD COLUMN artifact_path text,
  ADD COLUMN artifact_sha256 text,
  ADD COLUMN training_start date,
  ADD COLUMN training_end date,
  ADD COLUMN feature_config jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN latest_run_id uuid REFERENCES forecast.runs (id) ON DELETE SET NULL,
  ADD COLUMN eligibility_reason text,
  ADD COLUMN evaluated_at timestamptz,
  ADD CONSTRAINT model_artifact_pair CHECK (
    (artifact_path IS NULL) = (artifact_sha256 IS NULL)
    AND (artifact_sha256 IS NULL OR artifact_sha256 ~ '^[0-9a-f]{64}$')
  ),
  ADD CONSTRAINT fallback_not_activatable CHECK (
    kind <> 'FALLBACK' OR status IN ('CANDIDATE', 'REJECTED')
  );

CREATE UNIQUE INDEX model_versions_one_active_idx
  ON forecast.model_versions ((true)) WHERE status = 'ACTIVE';

CREATE TABLE forecast.model_activations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action        forecast.activation_action NOT NULL,
  from_model_id uuid REFERENCES forecast.model_versions (id),
  to_model_id   uuid NOT NULL REFERENCES forecast.model_versions (id),
  actor_id      uuid REFERENCES users (id),
  reason        text NOT NULL CHECK (length(trim(reason)) BETWEEN 5 AND 500),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT model_activation_shape CHECK (
    (action = 'BOOTSTRAP' AND from_model_id IS NULL AND actor_id IS NULL)
    OR (action IN ('ACTIVATE', 'ROLLBACK') AND from_model_id IS NOT NULL AND actor_id IS NOT NULL)
  ),
  CONSTRAINT model_activation_changes_model CHECK (from_model_id IS NULL OR from_model_id <> to_model_id)
);
CREATE INDEX model_activations_created_idx ON forecast.model_activations (created_at DESC);

CREATE FUNCTION forecast.model_activations_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Model activation history is append-only'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER model_activations_no_update
  BEFORE UPDATE OR DELETE ON forecast.model_activations
  FOR EACH ROW EXECUTE FUNCTION forecast.model_activations_immutable();

-- Preserve today's behaviour when upgrading an existing database. Fresh databases have no model
-- versions yet; the forecasting service records the first successful run as BOOTSTRAP instead.
WITH current_model AS (
  SELECT served_model_version_id AS id
    FROM forecast.runs
   WHERE status = 'SUCCEEDED' AND served_model_version_id IS NOT NULL
   ORDER BY finished_at DESC NULLS LAST, started_at DESC
   LIMIT 1
)
UPDATE forecast.model_versions m SET status = 'ACTIVE',
  eligibility_reason = 'Bootstrap from the model served by the latest successful pre-registry run',
  evaluated_at = now()
FROM current_model c WHERE m.id = c.id AND m.kind <> 'FALLBACK';

INSERT INTO forecast.model_activations (action, to_model_id, reason)
SELECT 'BOOTSTRAP', id, 'Bootstrap from the latest successful pre-registry forecast run'
  FROM forecast.model_versions WHERE status = 'ACTIVE';
