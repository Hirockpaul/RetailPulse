-- 0012 (V2 step 2a): ABC/XYZ classification of products, network-wide and per store.
--
-- Each calculation is a run with its data window, so a result can always be traced to the data it
-- came from. Rules: docs/V2-PLAN.md step 2a, modules/classifications/classifications.calc.ts.
-- A classification is advice for stocking policy; it changes no stock and no order by itself.

CREATE TABLE classification_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  calculated_at  timestamptz NOT NULL DEFAULT now(),
  window_start   date NOT NULL,
  window_end     date NOT NULL,
  data_label     text NOT NULL CHECK (data_label IN ('SYNTHETIC', 'LEDGER', 'MIXED')),
  item_count     integer NOT NULL CHECK (item_count >= 0),
  triggered_by   uuid REFERENCES users (id),          -- NULL = the daily background run
  CHECK (window_start <= window_end)
);
CREATE INDEX classification_runs_recent_idx ON classification_runs (calculated_at DESC);

CREATE TABLE inventory_classifications (
  run_id            uuid NOT NULL REFERENCES classification_runs (id) ON DELETE CASCADE,
  product_id        uuid NOT NULL REFERENCES products (id),
  location_id       uuid REFERENCES locations (id),    -- NULL = the whole network
  weeks_observed    integer NOT NULL CHECK (weeks_observed >= 0),
  units             integer NOT NULL CHECK (units >= 0),
  value             numeric(14, 2) NOT NULL CHECK (value >= 0),
  value_share       numeric(9, 6) NOT NULL CHECK (value_share BETWEEN 0 AND 1),
  cumulative_share  numeric(9, 6) NOT NULL CHECK (cumulative_share BETWEEN 0 AND 1.000001),
  weekly_mean       numeric(12, 4) NOT NULL CHECK (weekly_mean >= 0),
  cv                numeric(10, 4) CHECK (cv >= 0),
  adi               numeric(10, 4) CHECK (adi >= 1),
  abc               char(1) CHECK (abc IN ('A', 'B', 'C')),
  xyz               char(1) CHECK (xyz IN ('X', 'Y', 'Z')),
  cls               text NOT NULL CHECK (cls IN ('AX', 'AY', 'AZ', 'BX', 'BY', 'BZ', 'CX', 'CY', 'CZ', 'NEW')),
  CONSTRAINT classification_class_matches CHECK (
    (cls = 'NEW' AND abc IS NULL AND xyz IS NULL) OR cls = abc || xyz
  )
);
CREATE UNIQUE INDEX inventory_classifications_one_idx
  ON inventory_classifications (run_id, product_id, COALESCE(location_id, '00000000-0000-0000-0000-000000000000'));
CREATE INDEX inventory_classifications_scope_idx ON inventory_classifications (run_id, location_id, cls);
