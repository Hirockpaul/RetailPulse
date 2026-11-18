-- 0024: keep the reporting supplier score identical to the API when mean lead time is zero.
-- The API defines CV as zero in that case (perfect consistency), not one.

CREATE OR REPLACE VIEW reporting.supplier_performance WITH (security_barrier = true) AS
WITH stats AS (
  SELECT s.id AS supplier_id,
         s.code::text AS supplier_code,
         s.name AS supplier_name,
         count(d.id)::integer AS deliveries,
         count(d.id) FILTER (WHERE d.source = 'SYNTHETIC')::integer AS synthetic_deliveries,
         max(d.received_on) AS last_delivery,
         avg(d.received_on - d.ordered_on)::numeric AS mean_lead_days,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY d.received_on - d.ordered_on)::numeric
           AS median_lead_days,
         stddev_pop(d.received_on - d.ordered_on)::numeric AS std_lead_days,
         avg(((d.received_on - d.ordered_on) <= d.promised_days)::integer)::numeric
           AS on_time_rate,
         sum(d.received_qty)::numeric / nullif(sum(d.ordered_qty), 0) AS fill_rate
    FROM suppliers s
    LEFT JOIN supplier_deliveries d ON d.supplier_id = s.id
   GROUP BY s.id
)
SELECT *,
       CASE WHEN deliveries < 5 THEN NULL
            ELSE round(100 * (
              0.50 * on_time_rate
              + 0.30 * fill_rate
              + 0.20 * (1 - least(
                  CASE WHEN mean_lead_days > 0 THEN std_lead_days / mean_lead_days ELSE 0 END,
                  1
                ))
            ), 1)
       END AS reliability_score
  FROM stats;

COMMENT ON VIEW reporting.supplier_performance IS
  'Delivery aggregates and the documented reliability score; synthetic deliveries remain labelled.';
