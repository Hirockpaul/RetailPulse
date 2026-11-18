-- 0020 (V2 step 3c-1): model monitoring — drift and accuracy on newly observed days.
--
-- Written by the forecasting service after every forecast run and on demand. Monitoring only
-- describes: it never retrains, activates or changes a forecast. Rows are facts (no UPDATE); the
-- newest 30 monitoring runs are kept. Rules: docs/V2-PLAN.md step 3c-1.

CREATE TABLE forecast.monitoring_runs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at               timestamptz NOT NULL DEFAULT now(),
  trigger                  text NOT NULL CHECK (trigger IN ('FORECAST_RUN', 'MANUAL')),
  -- No FK: forecast runs are pruned (newest 5 kept) and these rows may not change afterwards.
  forecast_run_id          uuid,
  model_version_id         uuid REFERENCES forecast.model_versions (id),
  model_name               text,
  training_end             date,
  latest_data_day          date,
  reference_start          date,
  reference_end            date,
  current_start            date,                 -- NULL = no complete day after training yet
  current_end              date,
  current_days             integer NOT NULL DEFAULT 0 CHECK (current_days >= 0),
  status                   text NOT NULL CHECK (status IN ('SUCCEEDED', 'FAILED')),
  error                    text,
  data_drift_status        text CHECK (data_drift_status IN ('INSUFFICIENT_DATA', 'STABLE', 'WATCH', 'DRIFT')),
  prediction_drift_status  text CHECK (prediction_drift_status IN ('INSUFFICIENT_DATA', 'STABLE', 'WATCH', 'DRIFT')),
  performance_status       text CHECK (performance_status IN ('INSUFFICIENT_DATA', 'OK', 'DEGRADED')),
  CHECK ((status = 'FAILED') = (error IS NOT NULL)),
  CHECK (status = 'FAILED' OR (data_drift_status IS NOT NULL AND prediction_drift_status IS NOT NULL
                               AND performance_status IS NOT NULL))
);
CREATE INDEX monitoring_runs_recent_idx ON forecast.monitoring_runs (created_at DESC);

CREATE TABLE forecast.monitoring_results (
  run_id         uuid NOT NULL REFERENCES forecast.monitoring_runs (id) ON DELETE CASCADE,
  check_kind     text NOT NULL CHECK (check_kind IN ('FEATURE', 'STORE_SALES', 'PREDICTION', 'PERFORMANCE')),
  subject        text NOT NULL,                  -- feature name, store code, model name or run id
  location_id    uuid REFERENCES locations (id),  -- STORE_SALES only
  n_reference    integer CHECK (n_reference >= 0),
  n_current      integer CHECK (n_current >= 0),
  psi            numeric(12, 6) CHECK (psi >= 0),
  ks_d           numeric(8, 6) CHECK (ks_d BETWEEN 0 AND 1),
  ks_p           numeric(12, 10) CHECK (ks_p BETWEEN 0 AND 1),
  wape           numeric(10, 6) CHECK (wape >= 0),
  bias           numeric(10, 6),
  backtest_wape  numeric(10, 6) CHECK (backtest_wape >= 0),
  n_points       integer CHECK (n_points >= 0),
  n_days         integer CHECK (n_days >= 0),
  status         text NOT NULL CHECK (status IN ('INSUFFICIENT_DATA', 'STABLE', 'WATCH', 'DRIFT', 'OK', 'DEGRADED')),
  PRIMARY KEY (run_id, check_kind, subject)
);

CREATE FUNCTION forecast.monitoring_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'monitoring rows are facts and cannot be changed' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER monitoring_runs_immutable BEFORE UPDATE ON forecast.monitoring_runs
  FOR EACH ROW EXECUTE FUNCTION forecast.monitoring_immutable();
CREATE TRIGGER monitoring_results_immutable BEFORE UPDATE ON forecast.monitoring_results
  FOR EACH ROW EXECUTE FUNCTION forecast.monitoring_immutable();
