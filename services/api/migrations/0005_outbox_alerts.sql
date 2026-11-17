-- 0005: transactional outbox, idempotent-consumer ledger, and stock alerts.
--
-- No message broker: events are rows in outbox_events, written in the SAME transaction as the
-- change that caused them (so a rolled-back change leaves no event). A worker inside the API
-- claims pending rows with FOR UPDATE SKIP LOCKED and runs the registered consumers.
-- Delivery is at-least-once; processed_events makes every consumer's effect idempotent.

CREATE TYPE outbox_status AS ENUM ('PENDING', 'PROCESSED', 'DEAD');

CREATE TABLE outbox_events (
  seq              bigint GENERATED ALWAYS AS IDENTITY UNIQUE,   -- processing order
  id               uuid PRIMARY KEY,                             -- the eventId
  event_type       text NOT NULL,
  schema_version   integer NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  aggregate_type   text NOT NULL,
  aggregate_id     text NOT NULL,
  payload          jsonb NOT NULL,
  correlation_id   text,
  occurred_at      timestamptz NOT NULL,
  status           outbox_status NOT NULL DEFAULT 'PENDING',
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  processed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbox_processed_consistent CHECK ((status = 'PROCESSED') = (processed_at IS NOT NULL))
);

-- The worker's hot path: oldest pending event that is due.
CREATE INDEX outbox_pending_idx ON outbox_events (next_attempt_at, seq) WHERE status = 'PENDING';
CREATE INDEX outbox_status_idx ON outbox_events (status, seq DESC);

-- Events are facts: only the processing columns may change after insert.
CREATE FUNCTION outbox_events_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.event_type IS DISTINCT FROM OLD.event_type
     OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
     OR NEW.aggregate_type IS DISTINCT FROM OLD.aggregate_type
     OR NEW.aggregate_id IS DISTINCT FROM OLD.aggregate_id
     OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at THEN
    RAISE EXCEPTION 'outbox_events content is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outbox_events_immutable BEFORE UPDATE ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION outbox_events_immutable();

-- One row per (consumer, event) that has been handled. Inserted in the same transaction as the
-- consumer's own writes, so "handled" and "effect applied" can never disagree.
CREATE TABLE processed_events (
  consumer      text NOT NULL,
  event_id      uuid NOT NULL REFERENCES outbox_events (id),
  processed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

-- ------------------------------------------------------------------- alerts

CREATE TYPE alert_kind AS ENUM ('LOW_STOCK', 'OUT_OF_STOCK');
CREATE TYPE alert_status AS ENUM ('OPEN', 'RESOLVED');

CREATE TABLE alerts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             alert_kind NOT NULL,
  severity         text NOT NULL CHECK (severity IN ('MEDIUM', 'HIGH')),
  status           alert_status NOT NULL DEFAULT 'OPEN',
  product_id       uuid NOT NULL REFERENCES products (id),
  location_id      uuid NOT NULL REFERENCES locations (id),
  message          text NOT NULL,
  details          jsonb NOT NULL,          -- the inputs behind the alert, for "why was this raised?"
  source_event_id  uuid,                    -- event that last raised it (no FK: outbox rows may be purged)
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz,
  CONSTRAINT alerts_resolved_consistent CHECK ((status = 'RESOLVED') = (resolved_at IS NOT NULL))
);

-- At most one OPEN alert per product, location and kind: duplicates are impossible, even if the
-- same event is processed twice or two workers race.
CREATE UNIQUE INDEX alerts_one_open_idx ON alerts (product_id, location_id, kind) WHERE status = 'OPEN';
CREATE INDEX alerts_open_by_location_idx ON alerts (location_id, created_at DESC) WHERE status = 'OPEN';
CREATE INDEX alerts_product_idx ON alerts (product_id);
CREATE TRIGGER alerts_updated_at BEFORE UPDATE ON alerts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
