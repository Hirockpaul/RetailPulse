-- 0018 (V2 step 3a): honest registry metadata for model versions that predate the registry.
-- 0017 was already applied before this gap was found, so this is deliberately a new migration.

WITH latest_metric_run AS (
  SELECT DISTINCT ON (mm.model) mm.model, r.id AS run_id, r.history_start, r.train_end,
         r.feature_set, r.horizon_days, r.finished_at
    FROM forecast.model_metrics mm
    JOIN forecast.runs r ON r.id = mm.run_id AND r.status = 'SUCCEEDED'
   WHERE mm.split = 'validation'
   ORDER BY mm.model, r.finished_at DESC NULLS LAST, r.started_at DESC
)
UPDATE forecast.model_versions m
   SET latest_run_id = x.run_id,
       training_start = x.history_start,
       training_end = x.train_end,
       feature_config = jsonb_build_object(
         'features', to_jsonb(x.feature_set), 'horizonDays', x.horizon_days,
         'source', 'pre-registry run backfill'
       ),
       evaluated_at = x.finished_at
  FROM latest_metric_run x
 WHERE x.model = m.name AND m.latest_run_id IS NULL;

UPDATE forecast.model_versions
   SET status = 'REJECTED',
       eligibility_reason = CASE
         WHEN kind = 'FALLBACK' THEN 'Per-series fallback policy; not globally activatable.'
         ELSE 'Pre-registry version; run a new forecast to evaluate it against ACTIVE.'
       END
 WHERE status = 'CANDIDATE';
