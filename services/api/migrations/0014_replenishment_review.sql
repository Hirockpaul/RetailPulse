-- 0014 (V2 step 2d-1): expected stockout date, manual review, approved quantity.
--
-- * expected_stockout_on: first day the forecast says the stock position runs out (NULL = not
--   within 90 days, or no demand forecast). Older rows: NULL.
-- * review_reason: the automatic quantity is the least trustworthy (category-average fallback
--   forecast, or erratic Z-class demand at the store); approving needs a quantity and a note from
--   the manager. NULL = approve as suggested.
-- * approved_quantity: what was actually approved (the document's quantity). Only on APPROVED rows;
--   rows approved before this migration keep NULL (their document has the suggested quantity).
-- Rules: docs/V2-PLAN.md step 2d-1.

ALTER TABLE replenishment_recommendations
  ADD COLUMN expected_stockout_on date,
  ADD COLUMN review_reason text CHECK (review_reason IN ('FALLBACK_FORECAST', 'ERRATIC_DEMAND')),
  ADD COLUMN approved_quantity integer CHECK (approved_quantity > 0),
  ADD CONSTRAINT recommendation_approved_quantity_only_when_approved CHECK (
    approved_quantity IS NULL OR status = 'APPROVED'
  );
