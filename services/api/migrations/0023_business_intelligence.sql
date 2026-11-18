-- 0023 (V2 step 4d): read-only reporting views for Grafana business dashboards.
--
-- Grafana never queries application tables directly. The cluster-wide role is created NOLOGIN so
-- no credential is stored in source; the optional observability profile supplies its local-demo
-- password and enables login at startup. Views execute with their owner's privileges.

CREATE SCHEMA reporting;

CREATE VIEW reporting.sales_daily WITH (security_barrier = true) AS
SELECT d.day,
       d.location_id,
       l.code::text AS location_code,
       l.name AS location_name,
       d.product_id,
       p.sku::text AS sku,
       p.name AS product_name,
       c.name::text AS category,
       d.source,
       d.units,
       p.unit_price AS current_unit_price,
       round(d.units * p.unit_price, 2) AS value_at_current_price
  FROM forecast.demand_daily d
  JOIN locations l ON l.id = d.location_id
  JOIN products p ON p.id = d.product_id
  JOIN categories c ON c.id = p.category_id;

COMMENT ON VIEW reporting.sales_daily IS
  'Daily demand history; value uses the current catalog price. Synthetic rows remain labelled.';

CREATE VIEW reporting.inventory_snapshot WITH (security_barrier = true) AS
SELECT b.location_id,
       l.code::text AS location_code,
       l.name AS location_name,
       l.type::text AS location_type,
       b.product_id,
       p.sku::text AS sku,
       p.name AS product_name,
       c.name::text AS category,
       b.on_hand,
       b.reserved,
       b.on_hand - b.reserved AS available,
       p.unit_price,
       sp.unit_cost,
       round(b.on_hand * p.unit_price, 2) AS retail_value,
       round(b.on_hand * sp.unit_cost, 2) AS cost_value,
       b.updated_at
  FROM inventory_balances b
  JOIN locations l ON l.id = b.location_id
  JOIN products p ON p.id = b.product_id
  JOIN categories c ON c.id = p.category_id
  LEFT JOIN supplier_products sp ON sp.product_id = p.id AND sp.is_primary;

COMMENT ON VIEW reporting.inventory_snapshot IS
  'Current inventory snapshot; cost is the current primary-supplier unit cost.';

CREATE VIEW reporting.forecast_quality WITH (security_barrier = true) AS
SELECT r.id AS run_id,
       r.started_at,
       r.finished_at,
       r.history_start,
       r.history_end,
       r.data_label,
       r.selection_reason,
       m.model,
       m.split,
       m.mae,
       m.rmse,
       m.wape,
       m.bias,
       m.interval_coverage,
       m.interval95_coverage,
       m.interval_width,
       m.interval95_width,
       m.n_points,
       m.n_series,
       (mv.name = m.model) AS served_model
  FROM forecast.runs r
  JOIN forecast.model_metrics m ON m.run_id = r.id
  LEFT JOIN forecast.model_versions mv ON mv.id = r.served_model_version_id
 WHERE r.status = 'SUCCEEDED';

COMMENT ON VIEW reporting.forecast_quality IS
  'Time-ordered validation/test metrics for successful forecast runs; synthetic labels are retained.';

CREATE VIEW reporting.supplier_performance WITH (security_barrier = true) AS
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
              + 0.20 * (1 - least(coalesce(std_lead_days / nullif(mean_lead_days, 0), 1), 1))
            ), 1)
       END AS reliability_score
  FROM stats;

COMMENT ON VIEW reporting.supplier_performance IS
  'Delivery aggregates and the documented reliability score; synthetic deliveries remain labelled.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'retailpulse_grafana') THEN
    BEGIN
      CREATE ROLE retailpulse_grafana NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
    EXCEPTION WHEN duplicate_object THEN
      NULL; -- another test database may create the cluster-wide role concurrently
    END;
  END IF;
END
$$;

REVOKE ALL ON SCHEMA public, forecast FROM retailpulse_grafana;
REVOKE ALL ON ALL TABLES IN SCHEMA public, forecast FROM retailpulse_grafana;
GRANT USAGE ON SCHEMA reporting TO retailpulse_grafana;
GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO retailpulse_grafana;
