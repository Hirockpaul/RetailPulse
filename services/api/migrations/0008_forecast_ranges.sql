-- 0008 (V2 step 1b): forecast ranges from measured errors (split conformal, by forecast level).
--
-- * forecast.points gets a 95 % range next to the 80 % one (`lower`/`upper`). Rows of older runs
--   have no 95 % range (NULL).
-- * forecast.model_metrics gets the 95 % range's coverage and width (test window).
-- * forecast.interval_calibration keeps, per run, range level and forecast-level group, the error
--   quantiles used for the live ranges and how well the same method held on the test window —
--   so "how reliable is this range?" can be answered from data, per sales level.

ALTER TABLE forecast.points
  ADD COLUMN lower95 numeric(12, 4) CHECK (lower95 >= 0),
  ADD COLUMN upper95 numeric(12, 4),
  ADD CONSTRAINT points_ranges_nested CHECK (
    lower95 IS NULL OR (lower95 <= lower AND upper <= upper95)
  );

ALTER TABLE forecast.model_metrics
  ADD COLUMN interval95_coverage numeric(6, 4) CHECK (interval95_coverage BETWEEN 0 AND 1),
  ADD COLUMN interval95_width    numeric(12, 4) CHECK (interval95_width >= 0);

CREATE TABLE forecast.interval_calibration (
  run_id          uuid NOT NULL REFERENCES forecast.runs (id) ON DELETE CASCADE,
  level           integer NOT NULL CHECK (level IN (80, 95)),
  group_index     integer NOT NULL CHECK (group_index >= 0),
  forecast_from   numeric(10, 2) NOT NULL,          -- forecast level group, units/day: [from, to)
  forecast_to     numeric(10, 2),                   -- NULL = no upper limit
  q_low           numeric(12, 4) NOT NULL,          -- added to the forecast for the lower bound
  q_high          numeric(12, 4) NOT NULL,          -- added to the forecast for the upper bound
  n_calibration   integer NOT NULL CHECK (n_calibration >= 0),
  pooled          boolean NOT NULL,                 -- too few points: used all residuals instead
  test_coverage   numeric(6, 4) CHECK (test_coverage BETWEEN 0 AND 1),
  test_points     integer NOT NULL CHECK (test_points >= 0),
  PRIMARY KEY (run_id, level, group_index),
  CHECK (q_low <= q_high)
);
