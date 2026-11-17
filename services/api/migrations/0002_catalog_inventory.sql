-- 0002: catalog, locations, inventory balances and the append-only ledger.
--
-- Design (docs/ARCHITECTURE.md §3–4):
--   * Stock only changes by INSERTing an inventory_ledger row.
--   * A BEFORE INSERT trigger on the ledger locks and updates the matching balance row and
--     records the resulting on_hand_after / reserved_after on the ledger row.
--   * Direct UPDATE/INSERT of non-zero quantities on inventory_balances is rejected, and the
--     ledger rejects UPDATE/DELETE, so every balance is provably the sum of its ledger rows.

CREATE TYPE location_type AS ENUM ('STORE', 'DISTRIBUTION_CENTER');

CREATE TYPE movement_type AS ENUM (
  'SALE', 'RECEIPT', 'TRANSFER_OUT', 'TRANSFER_IN', 'RETURN', 'ADJUSTMENT',
  'RESERVATION', 'RESERVATION_RELEASE'
);

-- ---------------------------------------------------------------- catalog

CREATE TABLE categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        citext NOT NULL UNIQUE CHECK (length(btrim(name)) > 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE suppliers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        citext NOT NULL UNIQUE CHECK (code ~ '^[A-Za-z0-9-]{2,20}$'),
  name        text NOT NULL CHECK (length(btrim(name)) > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku          citext NOT NULL UNIQUE CHECK (sku ~ '^[A-Za-z0-9-]{3,32}$'),
  name         text NOT NULL CHECK (length(btrim(name)) > 0),
  category_id  uuid NOT NULL REFERENCES categories (id),
  unit_price   numeric(12, 2) NOT NULL CHECK (unit_price >= 0),
  pack_size    integer NOT NULL DEFAULT 1 CHECK (pack_size > 0),
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX products_category_idx ON products (category_id);

CREATE TABLE supplier_products (
  supplier_id     uuid NOT NULL REFERENCES suppliers (id),
  product_id      uuid NOT NULL REFERENCES products (id),
  lead_time_days  integer NOT NULL CHECK (lead_time_days BETWEEN 1 AND 365),
  min_order_qty   integer NOT NULL CHECK (min_order_qty > 0),
  unit_cost       numeric(12, 2) NOT NULL CHECK (unit_cost >= 0),
  is_primary      boolean NOT NULL DEFAULT false,
  PRIMARY KEY (supplier_id, product_id)
);
CREATE INDEX supplier_products_product_idx ON supplier_products (product_id);
-- At most one primary supplier per product.
CREATE UNIQUE INDEX supplier_products_one_primary ON supplier_products (product_id) WHERE is_primary;

-- -------------------------------------------------------------- locations

CREATE TABLE locations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        citext NOT NULL UNIQUE CHECK (code ~ '^[A-Za-z0-9-]{2,20}$'),
  name        text NOT NULL CHECK (length(btrim(name)) > 0),
  type        location_type NOT NULL,
  city        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER suppliers_updated_at BEFORE UPDATE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER products_updated_at BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER locations_updated_at BEFORE UPDATE ON locations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -------------------------------------------------------------- inventory

CREATE TABLE inventory_balances (
  product_id   uuid NOT NULL REFERENCES products (id),
  location_id  uuid NOT NULL REFERENCES locations (id),
  on_hand      integer NOT NULL DEFAULT 0,
  reserved     integer NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, location_id),
  CONSTRAINT inventory_on_hand_non_negative CHECK (on_hand >= 0),
  CONSTRAINT inventory_reserved_non_negative CHECK (reserved >= 0),
  -- available = on_hand - reserved can never go below zero.
  CONSTRAINT inventory_reserved_within_on_hand CHECK (reserved <= on_hand)
);
CREATE INDEX inventory_balances_location_idx ON inventory_balances (location_id);

CREATE TABLE inventory_ledger (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id      uuid NOT NULL,
  location_id     uuid NOT NULL,
  movement_type   movement_type NOT NULL,
  on_hand_delta   integer NOT NULL,
  reserved_delta  integer NOT NULL DEFAULT 0,
  on_hand_after   integer NOT NULL,   -- set by trigger
  reserved_after  integer NOT NULL,   -- set by trigger
  reason          text,
  reference_type  text,
  reference_id    text,
  correlation_id  text,
  actor_id        uuid,               -- FK to users added on Day 4
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (product_id, location_id) REFERENCES inventory_balances (product_id, location_id),
  -- Each movement type may only move quantities in its documented direction.
  CONSTRAINT ledger_delta_matches_type CHECK (
    CASE movement_type
      WHEN 'SALE'                THEN on_hand_delta < 0  AND reserved_delta = 0
      WHEN 'TRANSFER_OUT'        THEN on_hand_delta < 0  AND reserved_delta = 0
      WHEN 'RECEIPT'             THEN on_hand_delta > 0  AND reserved_delta = 0
      WHEN 'TRANSFER_IN'         THEN on_hand_delta > 0  AND reserved_delta = 0
      WHEN 'RETURN'              THEN on_hand_delta >= 0 AND reserved_delta = 0  -- 0 = damaged
      WHEN 'ADJUSTMENT'          THEN on_hand_delta <> 0 AND reserved_delta = 0
      WHEN 'RESERVATION'         THEN on_hand_delta = 0  AND reserved_delta > 0
      WHEN 'RESERVATION_RELEASE' THEN on_hand_delta = 0  AND reserved_delta < 0
    END
  ),
  CONSTRAINT ledger_adjustment_needs_reason CHECK (
    movement_type <> 'ADJUSTMENT' OR length(btrim(coalesce(reason, ''))) > 0
  )
);
CREATE INDEX inventory_ledger_balance_idx ON inventory_ledger (product_id, location_id, id DESC);
CREATE INDEX inventory_ledger_location_time_idx ON inventory_ledger (location_id, occurred_at);

-- Apply a ledger row to its balance (creating the balance row on first movement).
-- The UPDATE takes a row lock, so concurrent movements on the same balance serialize;
-- CHECK constraints on inventory_balances reject oversell and abort the whole transaction.
CREATE FUNCTION inventory_apply_ledger_entry() RETURNS trigger AS $$
DECLARE
  b inventory_balances%ROWTYPE;
BEGIN
  INSERT INTO inventory_balances (product_id, location_id)
  VALUES (NEW.product_id, NEW.location_id)
  ON CONFLICT DO NOTHING;

  UPDATE inventory_balances
     SET on_hand    = on_hand + NEW.on_hand_delta,
         reserved   = reserved + NEW.reserved_delta,
         updated_at = now()
   WHERE product_id = NEW.product_id AND location_id = NEW.location_id
  RETURNING * INTO b;

  NEW.on_hand_after  := b.on_hand;
  NEW.reserved_after := b.reserved;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER inventory_ledger_apply BEFORE INSERT ON inventory_ledger
  FOR EACH ROW EXECUTE FUNCTION inventory_apply_ledger_entry();

-- The ledger is append-only.
CREATE FUNCTION inventory_ledger_forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'inventory_ledger is append-only (% not allowed)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER inventory_ledger_append_only BEFORE UPDATE OR DELETE ON inventory_ledger
  FOR EACH ROW EXECUTE FUNCTION inventory_ledger_forbid_change();

-- Balances may only change through the ledger trigger (trigger depth > 1).
-- Creating an empty (0/0) balance row directly is allowed.
CREATE FUNCTION inventory_balances_guard() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.on_hand = 0 AND NEW.reserved = 0 THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'inventory_balances can only change via inventory_ledger'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER inventory_balances_guard BEFORE INSERT OR UPDATE ON inventory_balances
  FOR EACH ROW EXECUTE FUNCTION inventory_balances_guard();
