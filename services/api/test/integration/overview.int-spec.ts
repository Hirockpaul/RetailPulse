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
