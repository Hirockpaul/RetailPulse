-- 0009 (V2 step 1c): explanations of the machine-learning forecast (SHAP).
--
-- * forecast.runs.explanation_status   OK, NOT_ML (a simple method was served: nothing to
--                                       explain beyond its rule) or FAILED_CHECK (the SHAP values
--                                       did not add up to the model output, so none were stored).
-- * forecast.explanations              per product × store: tomorrow's forecast split exactly into
--                                       a starting point and one contribution per feature
--                                       (log units; exp(contribution) is a multiplying factor).
-- * forecast.feature_importance         per run: mean |contribution| of each feature over days 1-7.
-- Contributions describe the MODEL's forecast, not causes of real demand.

ALTER TABLE forecast.runs
  ADD COLUMN explanation_status text CHECK (explanation_status IN ('OK', 'NOT_ML', 'FAILED_CHECK'));

CREATE TABLE forecast.explanations (
  run_id         uuid NOT NULL REFERENCES forecast.runs (id) ON DELETE CASCADE,
  product_id     uuid NOT NULL REFERENCES products (id),
  location_id    uuid NOT NULL REFERENCES locations (id),
  horizon_day    integer NOT NULL CHECK (horizon_day >= 1),
  base_log       numeric(12, 6) NOT NULL,
  forecast       numeric(12, 4) NOT NULL CHECK (forecast >= 0),
  -- [{ "feature": "mean_7d", "value": 4.3, "contribution": 0.31 }, …] sorted by |contribution|
  contributions  jsonb NOT NULL CHECK (jsonb_typeof(contributions) = 'array'),
  PRIMARY KEY (run_id, product_id, location_id, horizon_day)
);

CREATE TABLE forecast.feature_importance (
  run_id          uuid NOT NULL REFERENCES forecast.runs (id) ON DELETE CASCADE,
  feature         text NOT NULL,
  mean_abs_contribution numeric(12, 6) NOT NULL CHECK (mean_abs_contribution >= 0),
  rank            integer NOT NULL CHECK (rank >= 1),
  PRIMARY KEY (run_id, feature),
  UNIQUE (run_id, rank)
);
