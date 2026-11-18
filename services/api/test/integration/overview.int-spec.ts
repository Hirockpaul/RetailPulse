/**
 * Day 7: the Overview read model. Forecast rows are written straight into the `forecast` schema
 * (as in replenishment.int-spec.ts) so every number can be checked by hand.
 */
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { loadEnv } from '../../src/core/config/env';
import { DEMO, login } from './auth-helpers';
import { prepareTestDatabase, releaseTestDatabase } from './test-db';

let url: string;
let app: INestApplication;
let db: pg.Client;
const cookies = {} as Record<keyof typeof DEMO, string>;
let str1: string;
let str2: string;
let products: { id: string; sku: string }[];

const get = (who: keyof typeof DEMO, path: string) =>
  request(app.getHttpServer()).get(`/api/v1${path}`).set('Cookie', cookies[who]);

beforeAll(async () => {
  url = await prepareTestDatabase();
  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: url, FORECAST_URL: 'http://127.0.0.1:1' });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).compile();
  app = configureApp(moduleRef.createNestApplication({ logger: false }));
  await app.init();
  db = new pg.Client({ connectionString: url });
  await db.connect();
  for (const who of Object.keys(DEMO) as (keyof typeof DEMO)[])
    cookies[who] = await login(app, DEMO[who]);
  const locations = (await get('admin', '/locations?pageSize=100').expect(200)).body.data;
  const idOf = (code: string) => locations.find((l: { code: string }) => l.code === code).id;
  str1 = idOf('STR-01');
  str2 = idOf('STR-02');
  products = (await get('admin', '/products?sort=sku:asc&pageSize=3').expect(200)).body.data;
}, 60_000);

afterAll(async () => {
  await db?.end();
  await app?.close();
  await releaseTestDatabase();
});

async function setOnHand(productId: string, locationId: string, target: number) {
  const rows = (await get('admin', `/products/${productId}/stock`).expect(200)).body.data;
  const onHand = rows.find((r: { locationId: string }) => r.locationId === locationId).onHand;
  if (onHand === target) return;
  await request(app.getHttpServer())
    .post('/api/v1/adjustments')
    .set('Cookie', cookies.admin)
    .set('Idempotency-Key', randomUUID())
    .send({ productId, locationId, delta: target - onHand, reason: 'overview test setup' })
    .expect(201);
}

/** A finished forecast run with a flat `perDay` forecast for each (product, store). */
async function seedForecast(specs: { product: string; location: string; perDay: number }[]) {
  const mv = await db.query(
    `INSERT INTO forecast.model_versions (name, version, kind, description)
     VALUES ('moving_average_28', '1', 'BASELINE', 'test') ON CONFLICT (name, version)
     DO UPDATE SET description = 'test' RETURNING id`,
  );
  const run = await db.query(
    `INSERT INTO forecast.runs (status, finished_at, horizon_days, data_label, history_start, history_end,
        train_end, validation_start, validation_end, test_start, test_end, series_count, fallback_count,
        served_model_version_id, selection_reason, ml_beat_baseline, feature_set)
     VALUES ('SUCCEEDED', now(), 14, 'SYNTHETIC', current_date - 300, current_date - 1, current_date - 1,
             current_date - 56, current_date - 29, current_date - 28, current_date - 1, $1, 0, $2,
             'test fixture', false, ARRAY['mean_7d'])
     RETURNING id`,
    [specs.length, mv.rows[0].id],
  );
  const runId = run.rows[0].id as string;
  for (const s of specs) {
    await db.query(
      `INSERT INTO forecast.series (run_id, product_id, location_id, history_days, model, is_fallback,
          avg_daily_28, std_daily_90, sigma, test_wape)
       VALUES ($1, $2, $3, 300, 'moving_average_28', false, $4, 1, 1, 0.3)`,
      [runId, s.product, s.location, s.perDay],
    );
    await db.query(
      `INSERT INTO forecast.points (run_id, product_id, location_id, target_day, horizon_day, yhat, lower, upper)
       SELECT $1, $2, $3, current_date + h, h, $4::numeric, 0, $4::numeric + 1
         FROM generate_series(1, 14) h`,
      [runId, s.product, s.location, s.perDay],
    );
  }
  return runId;
}

const count = async (sql: string): Promise<number> => (await db.query(sql)).rows[0].n;

describe('GET /overview', () => {
  it('without a forecast: counts stock-outs, never guesses risk or excess', async () => {
    await setOnHand(products[2].id, str1, 0);
    const body = (await get('analyst', '/overview').expect(200)).body;

    expect(body.storeCount).toBe(5);
    expect(body.freshness.forecast).toBeNull();
    expect(body.stock.outOfStock).toBeGreaterThanOrEqual(1);
    expect(body.stock.withoutForecast).toBe(body.stock.positions);
    expect(body.stock.atRisk).toBe(0);
    expect(body.stock.excess).toBe(0);
    expect(body.freshness.lastMovementAt).not.toBeNull();
    expect(body.rules).toEqual({ riskWindowDays: 7, excessCoverDays: 60 });
  });

  it('flags at-risk and excess positions from the latest forecast, with hand-checkable numbers', async () => {
    const [a, b, c] = products;
    await setOnHand(a.id, str1, 5); // 2/day → 14 needed over 7 days → at risk, 2.5 days of cover
    await setOnHand(b.id, str1, 200); // 1/day → limit 60 → 140 excess, 200 days of cover
    await setOnHand(c.id, str1, 0); // out of stock: counted as out, not as at risk
    const runId = await seedForecast([
      { product: a.id, location: str1, perDay: 2 },
      { product: b.id, location: str1, perDay: 1 },
      { product: c.id, location: str1, perDay: 1 },
    ]);

    const body = (await get('inventory', '/overview').expect(200)).body;
    expect(body.freshness.forecast).toMatchObject({ runId, dataLabel: 'SYNTHETIC' });
    expect(body.stock.withoutForecast).toBe(body.stock.positions - 3);
    expect(body.stock.atRisk).toBe(1);
    expect(body.stock.atRiskTop[0]).toMatchObject({
      sku: a.sku,
      locationCode: 'STR-01',
      available: 5,
      inbound: 0,
      demandWindow: 14,
      daysOfCover: 2.5,
    });
    expect(body.stock.excess).toBe(1);
    expect(body.stock.excessUnits).toBe(140);
    expect(body.stock.excessTop[0]).toMatchObject({
      sku: b.sku,
      excessUnits: 140,
      daysOfCover: 200,
    });
  });

  it('counts inbound stock: an approved transfer takes a position out of "at risk"', async () => {
    const [a] = products;
    const created = await request(app.getHttpServer())
      .post('/api/v1/transfers')
      .set('Cookie', cookies.admin)
      .set('Idempotency-Key', randomUUID())
      .send({
        sourceLocationId: str2,
        destinationLocationId: str1,
        lines: [{ productId: a.id, quantity: 10 }],
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/transfers/${created.body.id}/approve`)
      .set('Cookie', cookies.admin)
      .expect(201);

    const body = (await get('admin', '/overview').expect(200)).body;
    expect(body.stock.atRisk).toBe(0); // 5 available + 10 inbound ≥ 14
  });

  it('limits store managers to their own stores', async () => {
    const body = (await get('store2', '/overview').expect(200)).body;
    expect(body.storeCount).toBe(1);
    // The STR-01 fixtures above are invisible to STR-02's manager.
    expect(body.stock.excess).toBe(0);
    const all = (await get('admin', '/overview').expect(200)).body;
    expect(body.stock.positions).toBeLessThan(all.stock.positions);
  });

  it('requires a session and writes nothing', async () => {
    await request(app.getHttpServer()).get('/api/v1/overview').expect(401);
    const before = await count(
      `SELECT ((SELECT COUNT(*) FROM inventory_ledger) + (SELECT COUNT(*) FROM outbox_events)
             + (SELECT COUNT(*) FROM replenishment_recommendations))::int AS n`,
    );
    await get('analyst', '/overview').expect(200);
    const after = await count(
      `SELECT ((SELECT COUNT(*) FROM inventory_ledger) + (SELECT COUNT(*) FROM outbox_events)
             + (SELECT COUNT(*) FROM replenishment_recommendations))::int AS n`,
    );
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------- Control Tower (V2 4a-1)

describe('Control Tower data (V2 4a-1)', () => {
  type Ct = {
    kpis: Record<string, number>;
    risks: {
      atRisk7: number;
      atRisk14: number;
      delayedTransfers: number;
      overduePurchaseOrders: number;
      openAnomalies: number;
      openHighAnomalies: number;
      excess: { positions: number; units: number; valueAtCost: number };
      suppliersAtRisk: { code: string; score: number; openPurchaseOrders: number }[];
    };
    charts: {
      storeHealth: { locationCode: string; outOfStock: number; atRisk: number; excess: number }[];
      sales: {
        history: { day: string; units: number }[];
        forecast: { day: string; units: number }[];
      };
      suppliers: { code: string; score: number | null }[];
    };
    rules: Record<string, number>;
  };
  const ct = async (who: keyof typeof DEMO = 'admin') =>
    (await get(who, '/overview').expect(200)).body.controlTower as Ct;
  let adminId: string;
  let costOf: (productId: string) => Promise<number>;

  beforeAll(async () => {
    adminId = (await db.query(`SELECT id FROM users WHERE email = $1`, [DEMO.admin])).rows[0].id;
    costOf = async (productId) =>
      Number(
        (
          await db.query(
            `SELECT unit_cost FROM supplier_products WHERE product_id = $1 AND is_primary`,
            [productId],
          )
        ).rows[0].unit_cost,
      );
  });

  it('states its rules and reuses the Overview thresholds', async () => {
    expect((await ct()).rules).toEqual({
      riskWindowLongDays: 14,
      transferDelayDays: 2,
      supplierRiskScore: 75,
    });
  });

  it('stock KPIs move by exactly a hand-made adjustment, at primary-supplier cost', async () => {
    const [, , c] = products;
    const before = await ct();
    const stock = (await get('admin', `/products/${c.id}/stock`).expect(200)).body.data;
    const now = stock.find((r: { locationId: string }) => r.locationId === str2).onHand;
    await setOnHand(c.id, str2, now + 7);
    const after = await ct();
    expect(after.kpis.onHand - before.kpis.onHand).toBe(7);
    expect(after.kpis.available - before.kpis.available).toBe(7);
    expect(after.kpis.valueAtCost - before.kpis.valueAtCost).toBeCloseTo(
      7 * (await costOf(c.id)),
      2,
    );
  });

  it('at risk within 7 vs 14 days, and excess value at cost (checked by hand)', async () => {
    const extra = (await get('admin', '/products?sort=sku:asc&pageSize=3&page=3').expect(200)).body
      .data as { id: string }[];
    const [p7, p14, px] = extra;
    await setOnHand(p7.id, str1, 10); // 2/day: 14 needed in 7 days → at risk in both windows
    await setOnHand(p14.id, str1, 20); // 2/day: fine for 7 days (14), short for 14 days (28)
    await setOnHand(px.id, str1, 200); // 2/day: limit 120 → 80 excess
    const before = await ct();
    await seedForecast([p7, p14, px].map((p) => ({ product: p.id, location: str1, perDay: 2 })));
    const after = await ct();
    // The latest run replaces the earlier one: these three are the only forecast positions now.
    expect(after.risks.atRisk7).toBe(1);
    expect(after.risks.atRisk14).toBe(2);
    expect(after.risks.excess).toEqual({
      positions: 1,
      units: 80,
      valueAtCost: Math.round(80 * (await costOf(px.id)) * 100) / 100,
    });
    expect(after.kpis.excessValueAtCost).toBe(after.risks.excess.valueAtCost);
    const s1 = after.charts.storeHealth.find((h) => h.locationCode === 'STR-01')!;
    expect(s1).toMatchObject({ atRisk: 1, excess: 1 });
    expect(before.charts.storeHealth.length).toBe(after.charts.storeHealth.length);
    // Sales chart: 28 days of history ending yesterday, then the run's 14 forecast days.
    expect(after.charts.sales.history).toHaveLength(28);
    expect(after.charts.sales.forecast).toHaveLength(14);
    expect(after.charts.sales.forecast[0].units).toBeCloseTo(6, 6); // 3 products × 2
  });

  it('a transfer is delayed only after 2 days since approval / dispatch (boundary)', async () => {
    const [a] = products;
    const created = await request(app.getHttpServer())
      .post('/api/v1/transfers')
      .set('Cookie', cookies.admin)
      .set('Idempotency-Key', randomUUID())
      .send({
        sourceLocationId: str2,
        destinationLocationId: str1,
        lines: [{ productId: a.id, quantity: 1 }],
      })
      .expect(201);
    const id = created.body.id as string;
    await request(app.getHttpServer())
      .post(`/api/v1/transfers/${id}/approve`)
      .set('Cookie', cookies.admin)
      .expect(201);
    const base = (await ct()).risks.delayedTransfers;
    await db.query(
      `UPDATE stock_transfers SET approved_at = now() - interval '2 days' + interval '5 minutes' WHERE id = $1`,
      [id],
    );
    expect((await ct()).risks.delayedTransfers).toBe(base);
    await db.query(
      `UPDATE stock_transfers SET approved_at = now() - interval '2 days' - interval '5 minutes' WHERE id = $1`,
      [id],
    );
    expect((await ct()).risks.delayedTransfers).toBe(base + 1);
    // Touches STR-01 and STR-02: STR-02's manager sees it; a manager of neither would not.
    expect((await ct('store2')).risks.delayedTransfers).toBeGreaterThanOrEqual(1);
  });

  it('a purchase order is overdue only after its expected date, and counts for its supplier', async () => {
    const summit = (
      await db.query(`SELECT id, code::text FROM suppliers WHERE name LIKE 'Summit%'`)
    ).rows[0];
    const before = await ct();
    const insert = (days: number) =>
      db.query(
        `INSERT INTO purchase_orders (supplier_id, destination_location_id, expected_date, created_by)
         VALUES ($1, $2, current_date + $3::int, $4)`,
        [summit.id, str1, days, adminId],
      );
    await insert(0); // due today: not overdue yet
    expect((await ct()).risks.overduePurchaseOrders).toBe(before.risks.overduePurchaseOrders);
    await insert(-1); // due yesterday
    const after = await ct();
    expect(after.risks.overduePurchaseOrders).toBe(before.risks.overduePurchaseOrders + 1);
    // Summit scores below 75 on the seeded delivery history (69): a supply risk with 2 open orders.
    const risk = after.risks.suppliersAtRisk.find((x) => x.code === summit.code)!;
    expect(risk.score).toBeLessThan(75);
    expect(risk.openPurchaseOrders).toBe(2);
    expect(after.charts.suppliers.every((x) => x.score !== null)).toBe(true);
    // STR-02's manager does not see STR-01's orders.
    const s2 = await ct('store2');
    expect(s2.risks.overduePurchaseOrders).toBe(0);
    expect(s2.risks.suppliersAtRisk.find((x) => x.code === summit.code)!.openPurchaseOrders).toBe(
      0,
    );
  });

  it('open anomalies, and how many are HIGH, in scope', async () => {
    const [a] = products;
    const before = await ct();
    await db.query(
      `INSERT INTO forecast.anomaly_detections (product_id, location_id, day, kind, severity, score,
          observed, expected, method, rule, explanation)
       VALUES ($1, $2, current_date - 3, 'SPIKE', 'HIGH', 12, 40, 5, 'robust_z', 'test', 'test spike')`,
      [a.id, str1],
    );
    const after = await ct();
    expect(after.risks.openAnomalies).toBe(before.risks.openAnomalies + 1);
    expect(after.risks.openHighAnomalies).toBe(before.risks.openHighAnomalies + 1);
    expect(after.kpis.openAnomalies).toBe(after.risks.openAnomalies);
    expect((await ct('store2')).risks.openAnomalies).toBe(0);
  });

  it('GET /overview/locations: every location for admins, own stores only for managers', async () => {
    const rows = (await get('admin', '/overview/locations').expect(200)).body as {
      locationCode: string;
      locationType: string;
      onHand: number;
      outOfStock: number | null;
      atRisk: number | null;
      openAnomalies: number;
      transfersIn: number;
    }[];
    const all = (await db.query(`SELECT COUNT(*)::int AS n FROM locations`)).rows[0].n;
    expect(rows).toHaveLength(all);
    expect(rows[0].locationType).toBe('STORE'); // stores first, then DCs
    const dc = rows.find((r) => r.locationType === 'DISTRIBUTION_CENTER')!;
    expect(dc).toMatchObject({ outOfStock: null, atRisk: null });
    const kpis = (await ct()).kpis;
    expect(rows.reduce((n, r) => n + r.onHand, 0)).toBe(kpis.onHand);
    const s1 = rows.find((r) => r.locationCode === 'STR-01')!;
    expect(s1.atRisk).toBe(1);
    expect(s1.openAnomalies).toBeGreaterThanOrEqual(1);
    expect(s1.transfersIn).toBeGreaterThanOrEqual(1);

    const mine = (await get('store2', '/overview/locations').expect(200)).body;
    expect(mine.map((r: { locationCode: string }) => r.locationCode)).toEqual(['STR-02']);
    await request(app.getHttpServer()).get('/api/v1/overview/locations').expect(401);
  });

  it('reading the Control Tower writes nothing', async () => {
    const snapshot = () =>
      count(
        `SELECT ((SELECT COUNT(*) FROM inventory_ledger) + (SELECT COUNT(*) FROM outbox_events)
               + (SELECT COUNT(*) FROM stock_transfers) + (SELECT COUNT(*) FROM purchase_orders)
               + (SELECT COUNT(*) FROM replenishment_recommendations)
               + (SELECT COUNT(*) FROM forecast.anomaly_detections))::int AS n`,
      );
    const before = await snapshot();
    for (const who of ['admin', 'store1', 'analyst'] as const) {
      await get(who, '/overview').expect(200);
      await get(who, '/overview/locations').expect(200);
    }
    expect(await snapshot()).toBe(before);
  });
});
