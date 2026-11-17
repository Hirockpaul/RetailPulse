-- 0004: users, roles, store access, sessions, and stock transfers.
--
-- Transfers never edit balances: dispatch writes TRANSFER_OUT and receipt writes TRANSFER_IN
-- through the inventory ledger (InventoryService.applyMovement). The database also enforces the
-- allowed status transitions, so no code path can skip a step.

CREATE TYPE user_role AS ENUM ('ADMIN', 'INVENTORY_MANAGER', 'STORE_MANAGER', 'ANALYST');

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          citext NOT NULL UNIQUE CHECK (email ~ '^[^@\s]+@[^@\s]+$'),
  display_name   text NOT NULL CHECK (length(btrim(display_name)) > 0),
  password_hash  text NOT NULL,        -- scrypt$N$r$p$salt$hash, never the password
  role           user_role NOT NULL,
  is_active      boolean NOT NULL DEFAULT true,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Which stores a STORE_MANAGER may work in. Other roles ignore this table.
CREATE TABLE user_store_access (
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  location_id  uuid NOT NULL REFERENCES locations (id),
  PRIMARY KEY (user_id, location_id)
);
CREATE INDEX user_store_access_location_idx ON user_store_access (location_id);

-- Server-side sessions. Only a SHA-256 of the cookie token is stored, so a database leak
-- does not leak usable sessions.
CREATE TABLE sessions (
  id_hash     text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- Ledger rows now record who made the change (column existed since 0002).
ALTER TABLE inventory_ledger
  ADD CONSTRAINT inventory_ledger_actor_fkey FOREIGN KEY (actor_id) REFERENCES users (id);

-- ---------------------------------------------------------------- transfers

CREATE TYPE transfer_status AS ENUM ('REQUESTED', 'APPROVED', 'DISPATCHED', 'RECEIVED', 'CANCELLED');

CREATE TABLE stock_transfers (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_location_id       uuid NOT NULL REFERENCES locations (id),
  destination_location_id  uuid NOT NULL REFERENCES locations (id),
  status                   transfer_status NOT NULL DEFAULT 'REQUESTED',
  notes                    text,
  requested_by             uuid NOT NULL REFERENCES users (id),
  requested_at             timestamptz NOT NULL DEFAULT now(),
  approved_by              uuid REFERENCES users (id),
  approved_at              timestamptz,
  dispatched_by            uuid REFERENCES users (id),
  dispatched_at            timestamptz,
  received_by              uuid REFERENCES users (id),
  received_at              timestamptz,
  cancelled_by             uuid REFERENCES users (id),
  cancelled_at             timestamptz,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transfer_locations_differ CHECK (source_location_id <> destination_location_id),
  -- Timestamps must match the status (no half-finished states).
  CONSTRAINT transfer_status_matches_timestamps CHECK (
    CASE status
      WHEN 'REQUESTED'  THEN approved_at IS NULL AND dispatched_at IS NULL
                             AND received_at IS NULL AND cancelled_at IS NULL
      WHEN 'APPROVED'   THEN approved_at IS NOT NULL AND dispatched_at IS NULL
                             AND received_at IS NULL AND cancelled_at IS NULL
      WHEN 'DISPATCHED' THEN approved_at IS NOT NULL AND dispatched_at IS NOT NULL
                             AND received_at IS NULL AND cancelled_at IS NULL
      WHEN 'RECEIVED'   THEN approved_at IS NOT NULL AND dispatched_at IS NOT NULL
                             AND received_at IS NOT NULL AND cancelled_at IS NULL
      WHEN 'CANCELLED'  THEN cancelled_at IS NOT NULL AND dispatched_at IS NULL
                             AND received_at IS NULL
    END
  )
);
CREATE INDEX stock_transfers_status_idx ON stock_transfers (status, requested_at DESC);
CREATE INDEX stock_transfers_source_idx ON stock_transfers (source_location_id);
CREATE INDEX stock_transfers_destination_idx ON stock_transfers (destination_location_id);
CREATE TRIGGER stock_transfers_updated_at BEFORE UPDATE ON stock_transfers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE stock_transfer_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id  uuid NOT NULL REFERENCES stock_transfers (id),
  product_id   uuid NOT NULL REFERENCES products (id),
  quantity     integer NOT NULL CHECK (quantity > 0),
  UNIQUE (transfer_id, product_id)
);
CREATE INDEX stock_transfer_lines_product_idx ON stock_transfer_lines (product_id);

-- REQUESTED → APPROVED → DISPATCHED → RECEIVED, and REQUESTED|APPROVED → CANCELLED. Nothing else.
CREATE FUNCTION stock_transfers_check_transition() RETURNS trigger AS $$
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;
  IF (OLD.status::text || '>' || NEW.status::text) = ANY (ARRAY[
       'REQUESTED>APPROVED', 'REQUESTED>CANCELLED',
       'APPROVED>DISPATCHED', 'APPROVED>CANCELLED',
       'DISPATCHED>RECEIVED']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Illegal transfer status change % -> %', OLD.status, NEW.status
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stock_transfers_transition BEFORE UPDATE ON stock_transfers
  FOR EACH ROW EXECUTE FUNCTION stock_transfers_check_transition();
