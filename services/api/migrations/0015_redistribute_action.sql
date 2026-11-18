-- 0015 (V2 step 2d-2): a third recommendation action, moving excess store stock to a DC.
-- Its own migration: a new enum value cannot be used in the transaction that adds it (0016 does).

ALTER TYPE recommendation_action ADD VALUE IF NOT EXISTS 'REDISTRIBUTE_EXCESS';
