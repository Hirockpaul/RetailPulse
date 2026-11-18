-- 0010 (V2 step 1e-1): unusual sales found by the forecasting service.
--
-- Written by the forecasting service at the end of every forecast run, for the last 90 days.
-- A finding is a fact about one product × store × day and is never rewritten: a later run that
-- finds the same thing skips it (unique key). Review decisions (investigating, confirmed, …) are
-- people's work and belong to the API (step 1e-2), not to this table.
-- Detection never changes stock, orders or transfers.

CREATE TABLE forecast.anomaly_detections (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id   uuid NOT NULL REFERENCES products (id),
  location_id  uuid NOT NULL REFERENCES locations (id),
  day          date NOT NULL,                 -- for a DROP: the first of its zero-sales days
  kind         text NOT NULL CHECK (kind IN ('SPIKE', 'DROP')),
  severity     text NOT NULL CHECK (severity IN ('HIGH', 'MEDIUM')),
  score        numeric(10, 2) NOT NULL,       -- SPIKE: z; DROP: expected units over the run
  observed     numeric(12, 2) NOT NULL CHECK (observed >= 0),
  expected     numeric(12, 2) NOT NULL CHECK (expected >= 0),
  method       text NOT NULL,                 -- e.g. robust_z
  rule         text NOT NULL,                 -- version of the documented rule, e.g. v1
  explanation  text NOT NULL,
  run_id       uuid,                          -- forecast run that found it (no FK: runs are pruned)
  detected_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, location_id, day, kind)
);
CREATE INDEX anomaly_detections_recent_idx ON forecast.anomaly_detections (day DESC);
CREATE INDEX anomaly_detections_location_idx ON forecast.anomaly_detections (location_id);
