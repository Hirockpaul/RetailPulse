-- 0021 (V2 step 4b-1): what-if scenarios.
--
-- A scenario is a stored set of parameters; running it recomputes the replenishment batch in
-- memory for a baseline and for the scenario and stores ONE summary row. Running a scenario
-- writes nothing else (tested). Both tables are facts: a different idea is a new scenario.
-- Rules: docs/V2-PLAN.md step 4b-1.

CREATE TABLE scenarios (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  description              text CHECK (description IS NULL OR length(description) <= 500),
  demand_pct               integer NOT NULL CHECK (demand_pct BETWEEN -50 AND 200),
  supplier_lead_time_days  integer NOT NULL CHECK (supplier_lead_time_days BETWEEN 0 AND 30),
  dc_availability_pct      integer NOT NULL CHECK (dc_availability_pct BETWEEN 0 AND 100),
  created_by               uuid NOT NULL REFERENCES users (id),
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scenarios_recent_idx ON scenarios (created_at DESC);

CREATE TABLE scenario_results (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id            uuid NOT NULL REFERENCES scenarios (id),
  forecast_run_id        uuid NOT NULL,          -- no FK: forecast runs are pruned
  forecast_history_end   date,
  run_by                 uuid NOT NULL REFERENCES users (id),
  run_at                 timestamptz NOT NULL DEFAULT now(),
  duration_ms            integer NOT NULL CHECK (duration_ms >= 0),
  baseline               jsonb NOT NULL,
  result                 jsonb NOT NULL
);
CREATE INDEX scenario_results_scenario_idx ON scenario_results (scenario_id, run_at DESC);

CREATE FUNCTION scenarios_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'scenarios and their results are facts and cannot be changed'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER scenarios_no_update BEFORE UPDATE ON scenarios
  FOR EACH ROW EXECUTE FUNCTION scenarios_immutable();
CREATE TRIGGER scenario_results_no_update BEFORE UPDATE ON scenario_results
  FOR EACH ROW EXECUTE FUNCTION scenarios_immutable();
