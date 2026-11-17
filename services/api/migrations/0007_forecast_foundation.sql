-- 0007 (V2 step 1a): data foundation for honest forecast evaluation.
--
-- * forecast.promotions          the (synthetic) promotion calendar. Promotions are planned in
--                                advance, so the model may use them as a known input.
-- * forecast.injected_anomalies  ground-truth labels for anomalies the generator injected on
--                                purpose, so anomaly detection (step 1e) can be measured.
-- * model metrics                forecast bias, interval coverage and width, and per-horizon metrics.
--
-- All of these are written only by the forecasting service (it writes the forecast schema only).

CREATE TABLE forecast.promotions (
  product_id   uuid NOT NULL REFERENCES products (id),
  location_id  uuid NOT NULL REFERENCES locations (id),
  day          date NOT NULL,
  uplift       numeric(6, 3) NOT NULL CHECK (uplift > 1),   -- demand multiplier on that day
  source       text NOT NULL CHECK (source IN ('SYNTHETIC')),
  PRIMARY KEY (product_id, location_id, day)
);
CREATE INDEX promotions_day_idx ON forecast.promotions (day);

CREATE TABLE forecast.injected_anomalies (
  product_id      uuid NOT NULL REFERENCES products (id),
  location_id     uuid NOT NULL REFERENCES locations (id),
  day             date NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('SPIKE', 'DROP')),
  expected_units  numeric(12, 4) NOT NULL CHECK (expected_units >= 0),  -- true mean before injection
  actual_units    integer NOT NULL CHECK (actual_units >= 0),           -- value written to history
  source          text NOT NULL CHECK (source IN ('SYNTHETIC')),
  PRIMARY KEY (product_id, location_id, day)
);

-- bias = Σ(forecast − actual) / Σ actual  (positive = over-forecast)
-- interval_* = how often the actual value fell inside the 80 % range, and the range's mean width;
-- measured on the test window only, with a range built from validation errors (never test data).
ALTER TABLE forecast.model_metrics
  ADD COLUMN bias               numeric(10, 4),
  ADD COLUMN interval_coverage  numeric(6, 4) CHECK (interval_coverage BETWEEN 0 AND 1),
  ADD COLUMN interval_width     numeric(12, 4) CHECK (interval_width >= 0);

CREATE TABLE forecast.horizon_metrics (
  run_id       uuid NOT NULL REFERENCES forecast.runs (id) ON DELETE CASCADE,
  model        text NOT NULL,
  split        text NOT NULL CHECK (split IN ('validation', 'test')),
  horizon_day  integer NOT NULL CHECK (horizon_day >= 1),
  mae          numeric(12, 4),
  wape         numeric(10, 4),
  bias         numeric(10, 4),
  n_points     integer NOT NULL,
  PRIMARY KEY (run_id, model, split, horizon_day)
);
