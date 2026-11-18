-- 0016 (V2 step 2d-2): excess redistribution recommendations.
--
-- * REDISTRIBUTE_EXCESS belongs to the store WITH the excess (location_id) and names the DC to send
--   it to (destination_location_id). It has no supplier, no source location and no stockout risk.
-- * TRANSFER may now come from another store's excess too (source_location_id is any location).
-- Rules: docs/V2-PLAN.md step 2d-2.

ALTER TABLE replenishment_recommendations
  ADD COLUMN destination_location_id uuid REFERENCES locations (id),
  ALTER COLUMN risk DROP NOT NULL,
  DROP CONSTRAINT recommendation_action_fields,
  ADD CONSTRAINT recommendation_action_fields CHECK (
    (action = 'TRANSFER' AND source_location_id IS NOT NULL AND supplier_id IS NULL
       AND destination_location_id IS NULL AND risk IS NOT NULL)
    OR (action = 'PURCHASE_ORDER' AND supplier_id IS NOT NULL AND source_location_id IS NULL
       AND destination_location_id IS NULL AND risk IS NOT NULL)
    OR (action = 'REDISTRIBUTE_EXCESS' AND destination_location_id IS NOT NULL
       AND source_location_id IS NULL AND supplier_id IS NULL AND risk IS NULL
       AND destination_location_id <> location_id)
  ),
  -- Excess is never sent back for review: it is approved as suggested.
  ADD CONSTRAINT recommendation_redistribute_not_reviewed CHECK (
    action <> 'REDISTRIBUTE_EXCESS' OR review_reason IS NULL
  );
