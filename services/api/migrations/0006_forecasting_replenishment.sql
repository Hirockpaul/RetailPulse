-- 0006: demand forecasting, purchase orders and replenishment recommendations.
--
-- Ownership:
--   * schema `forecast` is written ONLY by the Python forecasting service (it reads sales
--     history and writes demand_daily, runs, metrics, series, points).
--   * purchase_orders and replenishment_recommendations are written ONLY by the API, and only
--     when a manager approves a recommendation. A forecast never creates an order or moves stock.

CREATE SCHEMA forecast;

-- ------------------------------------------------------------ demand history

-- Units sold per product, store and day. SYNTHETIC rows come from the seeded history generator;
-- LEDGER rows are rolled up from real SALE movements (complete days only).
CREATE TABLE forecast.demand_daily (
  product_id   uuid NOT NULL REFERENCES products (id),
  location_id  uuid NOT NULL REFERENCES locations (id),
  day          date NOT NULL,
  units        integer NOT NULL CHECK (units >= 0),
  source       text NOT NULL CHECK (source IN ('SYNTHETIC', 'LEDGER')),
  PRIMARY KEY (product_id, location_id, day)
);
CREATE INDEX demand_daily_day_idx ON forecast.demand_daily (day);

-- -------------------------------------------------------------------- models

CREATE TABLE forecast.model_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  version      text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('BASELINE', 'ML', 'FALLBACK')),
  description  text NOT NULL,
  params       jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, version)
);

CREATE TYPE forecast.run_status AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

CREATE TABLE forecast.runs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status                   forecast.run_status NOT NULL DEFAULT 'RUNNING',
  started_at               timestamptz NOT NULL DEFAULT now(),
  finished_at              timestamptz,
  horizon_days             integer NOT NULL CHECK (horizon_days BETWEEN 1 AND 28),
  data_label               text,                       -- SYNTHETIC | LEDGER | MIXED
  history_start            date,
  history_end              date,                       -- last observed day; forecasts start the day after
  train_end                date,                       -- final model is trained on data up to here
  validation_start         date,
  validation_end           date,
  test_start               date,
  test_end                 date,
  series_count             integer,
  fallback_count           integer,
  served_model_version_id  uuid REFERENCES forecast.model_versions (id),
  selection_reason         text,
  ml_beat_baseline         boolean,
  feature_set              text[],
  params                   jsonb,
  error                    text,
  CONSTRAINT runs_finished_consistent CHECK ((status = 'RUNNING') = (finished_at IS NULL))
);
-- Only one run may be in progress at a time.
CREATE UNIQUE INDEX forecast_one_running_run ON forecast.runs ((true)) WHERE status = 'RUNNING';
CREATE INDEX forecast_runs_status_idx ON forecast.runs (status, started_at DESC);

-- Accuracy of each model on time-ordered holdout windows (validation, then a final untouched test).
CREATE TABLE forecast.model_metrics (
  run_id     uuid NOT NULL REFERENCES forecast.runs (id) ON DELETE CASCADE,
  model      text NOT NULL,
  split      text NOT NULL CHECK (split IN ('validation', 'test')),
  mae        numeric(12, 4),
  rmse       numeric(12, 4),
  wape       numeric(10, 4),
  n_points   integer NOT NULL,
  n_series   integer NOT NULL,
  PRIMARY KEY (run_id, model, split)
);

-- One row per product × store: which model produced its forecast, and the numbers replenishment needs.
CREATE TABLE forecast.series (
  run_id        uuid NOT NULL REFERENCES forecast.runs (id) ON DELETE CASCADE,
  product_id    uuid NOT NULL REFERENCES products (id),
  location_id   uuid NOT NULL REFERENCES locations (id),
  history_days  integer NOT NULL CHECK (history_days >= 0),
  model         text NOT NULL,
  is_fallback   boolean NOT NULL,
  avg_daily_28  numeric(12, 4) NOT NULL,   -- mean units/day over the last 28 days
  std_daily_90  numeric(12, 4) NOT NULL,   -- standard deviation of daily units, last 90 days
  sigma         numeric(12, 4) NOT NULL,   -- typical forecast error (backtest RMSE), for intervals
  test_wape     numeric(10, 4),
  PRIMARY KEY (run_id, product_id, location_id)
);

CREATE TABLE forecast.points (
  run_id       uuid NOT NULL REFERENCES forecast.runs (id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES products (id),
  location_id  uuid NOT NULL REFERENCES locations (id),
  target_day   date NOT NULL,
  horizon_day  integer NOT NULL CHECK (horizon_day >= 1),
  yhat         numeric(12, 4) NOT NULL CHECK (yhat >= 0),
  lower        numeric(12, 4) NOT NULL CHECK (lower >= 0),
  upper        numeric(12, 4) NOT NULL,
  PRIMARY KEY (run_id, product_id, location_id, target_day)
);

-- ------------------------------------------------------------ purchase orders

CREATE TYPE po_status AS ENUM ('APPROVED', 'RECEIVED', 'CANCELLED');

-- Purchase orders are created only by approving a replenishment recommendation, so they start
-- APPROVED. Receiving one writes RECEIPT movements through the inventory ledger.
CREATE TABLE purchase_orders (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id               uuid NOT NULL REFERENCES suppliers (id),
  destination_location_id   uuid NOT NULL REFERENCES locations (id),
  status                    po_status NOT NULL DEFAULT 'APPROVED',
  expected_date             date NOT NULL,
  notes                     text,
  created_by                uuid NOT NULL REFERENCES users (id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  received_by               uuid REFERENCES users (id),
  received_at               timestamptz,
  cancelled_by              uuid REFERENCES users (id),
  cancelled_at              timestamptz,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT po_status_matches_timestamps CHECK (
    CASE status
      WHEN 'APPROVED'  THEN received_at IS NULL AND cancelled_at IS NULL
      WHEN 'RECEIVED'  THEN received_at IS NOT NULL AND cancelled_at IS NULL
      WHEN 'CANCELLED' THEN cancelled_at IS NOT NULL AND received_at IS NULL
    END
  )
);
CREATE INDEX purchase_orders_status_idx ON purchase_orders (status, created_at DESC);
CREATE INDEX purchase_orders_destination_idx ON purchase_orders (destination_location_id);
CREATE TRIGGER purchase_orders_updated_at BEFORE UPDATE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE purchase_order_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders (id),
  product_id        uuid NOT NULL REFERENCES products (id),
  quantity          integer NOT NULL CHECK (quantity > 0),
  unit_cost         numeric(12, 2) NOT NULL CHECK (unit_cost >= 0),   -- supplier cost at order time
  UNIQUE (purchase_order_id, product_id)
);
CREATE INDEX purchase_order_lines_product_idx ON purchase_order_lines (product_id);

CREATE FUNCTION purchase_orders_check_transition() RETURNS trigger AS $$
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;
  IF (OLD.status::text || '>' || NEW.status::text) = ANY (ARRAY['APPROVED>RECEIVED', 'APPROVED>CANCELLED']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Illegal purchase order status change % -> %', OLD.status, NEW.status
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER purchase_orders_transition BEFORE UPDATE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION purchase_orders_check_transition();

-- ------------------------------------------------------------- recommendations

CREATE TYPE recommendation_action AS ENUM ('TRANSFER', 'PURCHASE_ORDER');
CREATE TYPE recommendation_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');
CREATE TYPE stockout_risk AS ENUM ('CRITICAL', 'HIGH');

-- A suggestion for a manager. Nothing happens until a person approves it; approving creates
-- the transfer or purchase order and links it here.
CREATE TABLE replenishment_recommendations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  forecast_run_id   uuid NOT NULL,        -- run it was based on (no FK: old runs are pruned; inputs keep the facts)
  product_id        uuid NOT NULL REFERENCES products (id),
  location_id       uuid NOT NULL REFERENCES locations (id),
  action            recommendation_action NOT NULL,
  source_location_id uuid REFERENCES locations (id),
  supplier_id       uuid REFERENCES suppliers (id),
  quantity          integer NOT NULL CHECK (quantity > 0),
  risk              stockout_risk NOT NULL,
  days_of_cover     numeric(10, 2),
  status            recommendation_status NOT NULL DEFAULT 'PENDING',
  inputs            jsonb NOT NULL,       -- every input and intermediate value of the calculation
  explanation       text NOT NULL,        -- the same calculation, in words and numbers
  generated_at      timestamptz NOT NULL DEFAULT now(),
  decided_by        uuid REFERENCES users (id),
  decided_at        timestamptz,
  decision_note     text,
  transfer_id       uuid REFERENCES stock_transfers (id),
  purchase_order_id uuid REFERENCES purchase_orders (id),
  CONSTRAINT recommendation_action_fields CHECK (
    (action = 'TRANSFER' AND source_location_id IS NOT NULL AND supplier_id IS NULL)
    OR (action = 'PURCHASE_ORDER' AND supplier_id IS NOT NULL AND source_location_id IS NULL)
  ),
  CONSTRAINT recommendation_decision_consistent CHECK (
    (status IN ('APPROVED', 'REJECTED')) = (decided_at IS NOT NULL AND decided_by IS NOT NULL)
  ),
  -- An approved recommendation points at exactly one document; nothing else may point at one.
  CONSTRAINT recommendation_document_matches_status CHECK (
    CASE WHEN status = 'APPROVED'
         THEN (transfer_id IS NOT NULL) <> (purchase_order_id IS NOT NULL)
         ELSE transfer_id IS NULL AND purchase_order_id IS NULL END
  )
);
-- One live suggestion per product and store; generating again expires the old one.
CREATE UNIQUE INDEX recommendations_one_pending_idx
  ON replenishment_recommendations (product_id, location_id) WHERE status = 'PENDING';
CREATE INDEX recommendations_status_idx ON replenishment_recommendations (status, generated_at DESC);
CREATE INDEX recommendations_location_idx ON replenishment_recommendations (location_id);

-- PENDING → APPROVED | REJECTED | EXPIRED. Decisions are final.
CREATE FUNCTION recommendations_check_transition() RETURNS trigger AS $$
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'PENDING' AND NEW.status IN ('APPROVED', 'REJECTED', 'EXPIRED') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Illegal recommendation status change % -> %', OLD.status, NEW.status
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER recommendations_transition BEFORE UPDATE ON replenishment_recommendations
  FOR EACH ROW EXECUTE FUNCTION recommendations_check_transition();
