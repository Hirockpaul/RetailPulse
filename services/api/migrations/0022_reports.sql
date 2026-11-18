-- 0022 (V2 step 4c-1): generated reports.
--
-- A report is a frozen snapshot of one period (DAILY: one UTC day; WEEKLY: seven days ending on the
-- period end) and one scope (NULL location = the whole network), stored as JSON and never
-- recomputed. Scheduled reports are unique per kind, period and scope; manual ones may repeat.
-- Rules: docs/V2-PLAN.md step 4c-1.

CREATE TABLE report_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('DAILY', 'WEEKLY')),
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  location_id   uuid REFERENCES locations (id),
  trigger       text NOT NULL CHECK (trigger IN ('MANUAL', 'SCHEDULED')),
  generated_by  uuid REFERENCES users (id),
  generated_at  timestamptz NOT NULL DEFAULT now(),
  duration_ms   integer NOT NULL CHECK (duration_ms >= 0),
  content       jsonb NOT NULL,
  CHECK ((kind = 'DAILY' AND period_end = period_start)
      OR (kind = 'WEEKLY' AND period_end = period_start + 6)),
  CHECK ((trigger = 'SCHEDULED') = (generated_by IS NULL))
);
CREATE INDEX report_runs_recent_idx ON report_runs (generated_at DESC);
CREATE INDEX report_runs_location_idx ON report_runs (location_id, period_end DESC);
CREATE UNIQUE INDEX report_runs_scheduled_once_idx
  ON report_runs (kind, period_start, COALESCE(location_id, '00000000-0000-0000-0000-000000000000'))
  WHERE trigger = 'SCHEDULED';

CREATE FUNCTION report_runs_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'reports are snapshots and cannot be changed' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER report_runs_no_update BEFORE UPDATE ON report_runs
  FOR EACH ROW EXECUTE FUNCTION report_runs_immutable();

-- Report queries select ledger rows by time range.
CREATE INDEX IF NOT EXISTS inventory_ledger_occurred_idx ON inventory_ledger (occurred_at);
