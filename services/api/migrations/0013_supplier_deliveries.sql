-- 0013 (V2 step 2c): supplier deliveries, the basis of supplier performance statistics.
--
-- One row per delivered order line: when it was ordered, the lead time the supplier promised, when
-- it arrived, and how much of the order came. SYNTHETIC rows are 12 months of fictional history
-- written by `npm run db:seed` (no purchase orders, no stock movements: history only); ORDER rows
-- are added when a real purchase order is received (same transaction as its stock receipt).
-- Rules: docs/V2-PLAN.md step 2c. Facts: never updated.

CREATE TABLE supplier_deliveries (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id        uuid NOT NULL REFERENCES suppliers (id),
  product_id         uuid NOT NULL REFERENCES products (id),
  location_id        uuid NOT NULL REFERENCES locations (id),
  ordered_on         date NOT NULL,
  promised_days      integer NOT NULL CHECK (promised_days >= 0),
  received_on        date NOT NULL,
  ordered_qty        integer NOT NULL CHECK (ordered_qty > 0),
  received_qty       integer NOT NULL CHECK (received_qty >= 0 AND received_qty <= ordered_qty),
  source             text NOT NULL CHECK (source IN ('SYNTHETIC', 'ORDER')),
  purchase_order_id  uuid REFERENCES purchase_orders (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (received_on >= ordered_on),
  CHECK ((source = 'ORDER') = (purchase_order_id IS NOT NULL))
);
CREATE UNIQUE INDEX supplier_deliveries_order_line_idx
  ON supplier_deliveries (purchase_order_id, product_id) WHERE purchase_order_id IS NOT NULL;
CREATE INDEX supplier_deliveries_supplier_idx ON supplier_deliveries (supplier_id, product_id, received_on);

CREATE FUNCTION supplier_deliveries_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'supplier_deliveries rows are facts and cannot be changed' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER supplier_deliveries_immutable BEFORE UPDATE ON supplier_deliveries
  FOR EACH ROW EXECUTE FUNCTION supplier_deliveries_immutable();
