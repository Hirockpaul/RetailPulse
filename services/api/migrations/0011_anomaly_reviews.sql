-- 0011 (V2 step 1e-2): operational anomalies and the review workflow.
--
-- * operational_anomalies  unusual stock adjustments and returns, found by the API's event
--                          consumer (rules in modules/anomalies/anomalies.config.ts). Facts: never
--                          rewritten.
-- * anomaly_reviews        what people decided about a finding — sales (forecast.anomaly_detections,
--                          written by the forecasting service) or operational. No row = NEW.
-- * anomaly_review_events  every status change, with who, when and why (append-only).
-- * anomaly_findings       one view over both kinds of finding plus their review status.
-- Nothing here changes stock: a confirmed anomaly is fixed, if at all, by a normal movement.

CREATE TABLE operational_anomalies (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id       uuid NOT NULL REFERENCES products (id),
  location_id      uuid NOT NULL REFERENCES locations (id),
  day              date NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('LARGE_WRITE_OFF', 'FREQUENT_ADJUSTMENTS', 'HIGH_RETURN_RATE')),
  severity         text NOT NULL CHECK (severity IN ('HIGH', 'MEDIUM')),
  score            numeric(12, 2) NOT NULL,
  observed         numeric(12, 2) NOT NULL,
  expected         numeric(12, 2) NOT NULL,      -- the rule's threshold
  explanation      text NOT NULL,
  details          jsonb NOT NULL,               -- every input of the rule
  source_event_id  uuid,                         -- event that triggered it (no FK: outbox is purged)
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, location_id, day, kind)
);
CREATE INDEX operational_anomalies_recent_idx ON operational_anomalies (product_id, location_id, kind, day DESC);

CREATE TYPE anomaly_status AS ENUM ('NEW', 'INVESTIGATING', 'CONFIRMED', 'DISMISSED', 'RESOLVED');

CREATE TABLE anomaly_reviews (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_detection_id     uuid UNIQUE REFERENCES forecast.anomaly_detections (id),
  operational_anomaly_id uuid UNIQUE REFERENCES operational_anomalies (id),
  status                 anomaly_status NOT NULL,
  updated_by             uuid NOT NULL REFERENCES users (id),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT anomaly_review_one_finding CHECK (
    (sales_detection_id IS NULL) <> (operational_anomaly_id IS NULL)
  )
);

-- Allowed steps; decisions are final once DISMISSED or RESOLVED (enforced here too, not only in code).
CREATE FUNCTION anomaly_reviews_check_transition() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- The first decision about a NEW finding.
    IF NEW.status NOT IN ('INVESTIGATING', 'CONFIRMED', 'DISMISSED') THEN
      RAISE EXCEPTION 'anomaly review cannot go from NEW to %', NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;
  IF (OLD.status::text || '>' || NEW.status::text) = ANY (ARRAY[
       'INVESTIGATING>CONFIRMED', 'INVESTIGATING>DISMISSED', 'CONFIRMED>RESOLVED']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'anomaly review cannot go from % to %', OLD.status, NEW.status
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER anomaly_reviews_transition BEFORE INSERT OR UPDATE ON anomaly_reviews
  FOR EACH ROW EXECUTE FUNCTION anomaly_reviews_check_transition();

CREATE TABLE anomaly_review_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  review_id    uuid NOT NULL REFERENCES anomaly_reviews (id),
  from_status  anomaly_status NOT NULL,
  to_status    anomaly_status NOT NULL,
  note         text,
  actor_id     uuid NOT NULL REFERENCES users (id),
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX anomaly_review_events_review_idx ON anomaly_review_events (review_id, id);

CREATE FUNCTION anomaly_review_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'anomaly_review_events is append-only' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER anomaly_review_events_append_only BEFORE UPDATE OR DELETE ON anomaly_review_events
  FOR EACH ROW EXECUTE FUNCTION anomaly_review_events_append_only();

CREATE VIEW anomaly_findings AS
  SELECT d.id, 'SALES'::text AS source, d.product_id, d.location_id, d.day, d.kind, d.severity,
         d.score, d.observed, d.expected, d.explanation, NULL::jsonb AS details,
         d.method || ' ' || d.rule AS rule, d.detected_at AS found_at,
         COALESCE(r.status, 'NEW') AS status, r.id AS review_id, r.updated_at AS reviewed_at
    FROM forecast.anomaly_detections d
    LEFT JOIN anomaly_reviews r ON r.sales_detection_id = d.id
  UNION ALL
  SELECT o.id, 'OPERATIONS', o.product_id, o.location_id, o.day, o.kind, o.severity,
         o.score, o.observed, o.expected, o.explanation, o.details,
         'rules v1', o.created_at,
         COALESCE(r.status, 'NEW'), r.id, r.updated_at
    FROM operational_anomalies o
    LEFT JOIN anomaly_reviews r ON r.operational_anomaly_id = o.id;
