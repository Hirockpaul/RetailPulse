/** V2 step 4d: reporting views and Grafana's restricted database role. */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { prepareTestDatabase, releaseTestDatabase } from './test-db';

let db: pg.Client;

beforeAll(async () => {
  const url = await prepareTestDatabase();
  db = new pg.Client({ connectionString: url });
  await db.connect();

  const { rows } = await db.query<{ product_id: string; location_id: string }>(
    `SELECT b.product_id, b.location_id
       FROM inventory_balances b JOIN locations l ON l.id = b.location_id
      WHERE l.type = 'STORE' ORDER BY l.code, b.product_id LIMIT 1`,
  );
  await db.query(
    `INSERT INTO forecast.demand_daily (product_id, location_id, day, units, source)
     VALUES ($1, $2, current_date - 1, 7, 'SYNTHETIC')`,
    [rows[0].product_id, rows[0].location_id],
  );
  const model = await db.query<{ id: string }>(
    `INSERT INTO forecast.model_versions (name, version, kind, description)
     VALUES ('bi_test_model', '1', 'BASELINE', 'Integration-test model') RETURNING id`,
  );
  const run = await db.query<{ id: string }>(
    `INSERT INTO forecast.runs (status, started_at, finished_at, horizon_days, data_label,
       history_start, history_end, served_model_version_id, selection_reason)
     VALUES ('SUCCEEDED', now() - interval '1 minute', now(), 7, 'SYNTHETIC',
       current_date - 30, current_date - 1, $1, 'Integration-test selection') RETURNING id`,
    [model.rows[0].id],
  );
  await db.query(
    `INSERT INTO forecast.model_metrics (run_id, model, split, mae, rmse, wape, bias,
       interval_coverage, interval_width, interval95_coverage, interval95_width, n_points, n_series)
     VALUES ($1, 'bi_test_model', 'test', 1, 2, 0.25, -0.05, 0.80, 4, 0.95, 8, 100, 10)`,
    [run.rows[0].id],
  );
});

afterAll(async () => {
  await db?.end();
  await releaseTestDatabase();
});

describe('business intelligence reporting boundary', () => {
  it('exposes sales, current inventory, forecast quality and supplier performance facts', async () => {
    const sales = await db.query(
      `SELECT units, value_at_current_price, source FROM reporting.sales_daily
        WHERE day = current_date - 1`,
    );
    expect(sales.rows).toEqual([
      { units: 7, value_at_current_price: expect.any(String), source: 'SYNTHETIC' },
    ]);

    const inventory = await db.query(
      `SELECT count(*)::int AS rows, bool_and(available = on_hand - reserved) AS consistent,
              bool_and(cost_value IS NOT NULL) AS costed
         FROM reporting.inventory_snapshot`,
    );
    expect(inventory.rows[0]).toEqual({ rows: 1400, consistent: true, costed: true });

    const quality = await db.query(
      `SELECT model, split, wape::float8 AS wape, bias::float8 AS bias,
              interval95_coverage::float8 AS coverage, served_model
         FROM reporting.forecast_quality WHERE model = 'bi_test_model'`,
    );
    expect(quality.rows).toEqual([
      {
        model: 'bi_test_model',
        split: 'test',
        wape: 0.25,
        bias: -0.05,
        coverage: 0.95,
        served_model: true,
      },
    ]);

    const suppliers = await db.query(
      `SELECT supplier_code, deliveries, synthetic_deliveries, reliability_score::float8 AS score
         FROM reporting.supplier_performance ORDER BY supplier_code`,
    );
    expect(suppliers.rows).toHaveLength(3);
    expect(suppliers.rows.every((row) => row.deliveries === row.synthetic_deliveries)).toBe(true);
    expect(suppliers.rows.every((row) => row.score > 0 && row.score <= 100)).toBe(true);
  });

  it('uses the application score rule when every delivery arrives on the order day', async () => {
    const supplier = await db.query<{ id: string }>(
      `INSERT INTO suppliers (code, name) VALUES ('BI-ZERO', 'Zero Lead Test') RETURNING id`,
    );
    await db.query(
      `INSERT INTO supplier_deliveries (supplier_id, product_id, location_id, ordered_on,
         promised_days, received_on, ordered_qty, received_qty, source)
       SELECT $1, p.id, l.id, current_date - n, 0, current_date - n, 10, 10, 'SYNTHETIC'
         FROM (SELECT id FROM products ORDER BY sku LIMIT 1) p,
              (SELECT id FROM locations WHERE type = 'STORE' ORDER BY code LIMIT 1) l,
              generate_series(1, 5) n`,
      [supplier.rows[0].id],
    );
    const result = await db.query<{ score: number }>(
      `SELECT reliability_score::float8 AS score
         FROM reporting.supplier_performance WHERE supplier_code = 'BI-ZERO'`,
    );
    expect(result.rows[0].score).toBe(100);
  });

  it('lets the Grafana role read reporting views but denies base-table reads and writes', async () => {
    const privileges = await db.query<{ view_select: boolean; base_select: boolean }>(
      `SELECT has_table_privilege('retailpulse_grafana', 'reporting.sales_daily', 'SELECT') AS view_select,
              has_table_privilege('retailpulse_grafana', 'products', 'SELECT') AS base_select`,
    );
    expect(privileges.rows[0]).toEqual({ view_select: true, base_select: false });

    await db.query('SET ROLE retailpulse_grafana');
    try {
      for (const view of [
        'sales_daily',
        'inventory_snapshot',
        'forecast_quality',
        'supplier_performance',
      ]) {
        await expect(db.query(`SELECT * FROM reporting.${view} LIMIT 1`)).resolves.toBeDefined();
      }
      await expect(db.query('SELECT * FROM products LIMIT 1')).rejects.toThrow(/permission denied/);
      await expect(
        db.query(`INSERT INTO forecast.demand_daily
          SELECT product_id, location_id, current_date, 1, 'SYNTHETIC'
            FROM reporting.sales_daily LIMIT 1`),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await db.query('RESET ROLE');
    }
  });

  it('provisions four valid PostgreSQL dashboards with unique ids and synthetic labels', () => {
    const directory = resolve(__dirname, '../../../../ops/observability/grafana/dashboards');
    const files = readdirSync(directory).filter((name) => name.startsWith('retailpulse-'));
    const dashboards = files.map((name) =>
      JSON.parse(readFileSync(resolve(directory, name), 'utf8')),
    );
    expect(dashboards).toHaveLength(5); // four business dashboards + the existing API dashboard
    expect(new Set(dashboards.map((dashboard) => dashboard.uid)).size).toBe(5);
    const business = dashboards.filter((dashboard) => dashboard.tags.includes('business'));
    expect(business).toHaveLength(4);
    for (const dashboard of business) {
      expect(dashboard.description.toLowerCase()).toContain('synthetic');
      expect(dashboard.panels.length).toBeGreaterThanOrEqual(6);
      expect(
        dashboard.panels.every(
          (panel: { datasource?: { uid?: string } }) =>
            panel.datasource?.uid === 'retailpulse-postgres',
        ),
      ).toBe(true);
    }
  });
});
