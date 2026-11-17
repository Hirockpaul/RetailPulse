-- 0003: POS sales, reservations and idempotency keys.
-- Stock itself still changes only through inventory_ledger (migration 0002); these tables
-- hold the business documents that explain *why* a movement happened.

CREATE TYPE reservation_status AS ENUM ('ACTIVE', 'RELEASED');

CREATE TABLE sales_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id     uuid NOT NULL REFERENCES locations (id),
  total_amount    numeric(12, 2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  correlation_id  text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sales_orders_location_time_idx ON sales_orders (location_id, created_at);

CREATE TABLE sales_order_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL REFERENCES sales_orders (id),
  product_id  uuid NOT NULL REFERENCES products (id),
  quantity    integer NOT NULL CHECK (quantity > 0),
  unit_price  numeric(12, 2) NOT NULL CHECK (unit_price >= 0),  -- price at time of sale
  UNIQUE (order_id, product_id)
);
CREATE INDEX sales_order_lines_product_idx ON sales_order_lines (product_id);

CREATE TABLE reservations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id   uuid NOT NULL REFERENCES products (id),
  location_id  uuid NOT NULL REFERENCES locations (id),
  quantity     integer NOT NULL CHECK (quantity > 0),
  status       reservation_status NOT NULL DEFAULT 'ACTIVE',
  reference    text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  released_at  timestamptz,
  CONSTRAINT reservations_release_consistent CHECK ((status = 'RELEASED') = (released_at IS NOT NULL))
);
CREATE INDEX reservations_active_idx ON reservations (product_id, location_id) WHERE status = 'ACTIVE';
CREATE INDEX reservations_location_idx ON reservations (location_id, created_at DESC);

-- A request is identified by (key, endpoint). The row is written in the same transaction as
-- the work it protects, so a rolled-back request leaves no key behind and can be retried.
CREATE TABLE idempotency_keys (
  key              text NOT NULL CHECK (length(key) BETWEEN 8 AND 100),
  endpoint         text NOT NULL,
  request_hash     text NOT NULL,
  response_status  integer,
  response_body    jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key, endpoint)
);
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);
