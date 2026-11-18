/**
 * V2 4b-1: what-if scenarios against a real PostgreSQL. Forecast rows are written straight into
 * the forecast schema (as in the other integration tests) so the directions can be checked.
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
let dcN: string;
let dcS: string;

type Summary = {
  recommendations: number;
  byAction: { TRANSFER: number; PURCHASE_ORDER: number; REDISTRIBUTE_EXCESS: number };
  units: { TRANSFER: number; PURCHASE_ORDER: number; REDISTRIBUTE_EXCESS: number };
  transfersFromDc: number;
  purchaseOrderValueAtCost: number;
  positions: number;
  outOfStockNow: number;
  stockoutWithin7: number;
  stockoutWithin14: number;
};

const http = () => request(app.getHttpServer());
const as = (who: keyof typeof DEMO) => ({
  get: (path: string) => http().get(`/api/v1${path}`).set('Cookie', cookies[who]),
  post: (path: string, body: object = {}) =>
    http().post(`/api/v1${path}`).set('Cookie', cookies[who]).send(body),
});

async function setOnHand(productId: string, locationId: string, target: number) {
  const rows = (await as('admin').get(`/products/${productId}/stock`).expect(200)).body.data;
  const onHand = rows.find((r: { locationId: string }) => r.locationId === locationId)?.onHand ?? 0;
  if (onHand === target) return;
  await http()
    .post('/api/v1/adjustments')
    .set('Cookie', cookies.admin)
    .set('Idempotency-Key', randomUUID())
    .send({ productId, locationId, delta: target - onHand, reason: 'scenario test setup' })
    .expect(201);
}

/** A finished forecast run with a flat `perDay` forecast for each (product, store). */
async function seedForecast(specs: { product: string; location: string; perDay: number }[]) {
  const mv = await db.query(
    `INSERT INTO forecast.model_versions (name, version, kind, description)
     VALUES ('moving_average_28', '1', 'BASELINE', 'test') ON CONFLICT (name, version)
     DO UPDATE SET description = 'test' RETURNING id`,
  );
  const runId = (
    await db.query(
      `INSERT INTO forecast.runs (status, finished_at, horizon_days, data_label, history_start,
          history_end, train_end, validation_start, validation_end, test_start, test_end,
          series_count, fallback_count, served_model_version_id, selection_reason,
          ml_beat_baseline, feature_set)
       VALUES ('SUCCEEDED', now(), 14, 'SYNTHETIC', current_date - 300, current_date - 1,
               current_date - 1, current_date - 56, current_date - 29, current_date - 28,
               current_date - 1, $1, 0, $2, 'test fixture', false, ARRAY['mean_7d'])
       RETURNING id`,
      [specs.length, mv.rows[0].id],
    )
  ).rows[0].id as string;
  for (const s of specs) {
    await db.query(
      `INSERT INTO forecast.series (run_id, product_id, location_id, history_days, model,
          is_fallback, avg_daily_28, std_daily_90, sigma, test_wape)
       VALUES ($1, $2, $3, 300, 'moving_average_28', false, $4, 3, 3, 0.3)`,
      [runId, s.product, s.location, s.perDay],
    );
    await db.query(
      `INSERT INTO forecast.points (run_id, product_id, location_id, target_day, horizon_day,
          yhat, lower, upper)
       SELECT $1, $2, $3, current_date + h, h, $4::numeric, 0, $4::numeric + 2
         FROM generate_series(1, 14) h`,
      [runId, s.product, s.location, s.perDay],
    );
  }
}

/** Everything a scenario run must leave untouched: row counts and a checksum of every balance. */
const untouched = async () =>
  (
    await db.query(
      `SELECT (SELECT count(*) FROM inventory_ledger)::int AS ledger,
              (SELECT md5(string_agg(product_id || ':' || location_id || ':' || on_hand || ':' ||
                      reserved, ',' ORDER BY product_id, location_id)) FROM inventory_balances) AS balances,
              (SELECT count(*) FROM outbox_events)::int AS outbox,
              (SELECT count(*) FROM stock_transfers)::int AS transfers,
              (SELECT count(*) FROM purchase_orders)::int AS orders,
              (SELECT count(*) FROM replenishment_recommendations)::int AS recommendations,
              (SELECT count(*) FROM alerts)::int AS alerts,
              (SELECT count(*) FROM scenarios)::int AS scenarios`,
    )
  ).rows[0];

const create = async (
  demandPct: number,
  supplierLeadTimeDays: number,
  dcAvailabilityPct: number,
  name = `s ${demandPct}/${supplierLeadTimeDays}/${dcAvailabilityPct}`,
) =>
  (
    await as('inventory')
      .post('/scenarios', { name, demandPct, supplierLeadTimeDays, dcAvailabilityPct })
      .expect(201)
  ).body as { id: string };
const run = async (id: string) =>
  (await as('inventory').post(`/scenarios/${id}/run`).expect(200)).body as {
    baseline: Summary;
    result: Summary;
    forecastRunId: string;
    durationMs: number;
    runBy: string;
  };

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
  const locations = (await as('admin').get('/locations?pageSize=100').expect(200)).body.data;
  const idOf = (code: string) => locations.find((l: { code: string }) => l.code === code).id;
  [str1, str2, dcN, dcS] = ['STR-01', 'STR-02', 'DC-NORTH', 'DC-SOUTH'].map(idOf);
}, 60_000);

afterAll(async () => {
  await db?.end();
  await app?.close();
  await releaseTestDatabase();
});

describe('what-if scenarios (V2 4b-1)', () => {
  it('needs a forecast to run; the scenario itself can be stored first', async () => {
    const s = await create(10, 0, 0, 'before any forecast');
    const res = await as('inventory').post(`/scenarios/${s.id}/run`).expect(409);
    expect(res.body.error.code).toBe('NO_FORECAST');
  });

  describe('with a forecast', () => {
    beforeAll(async () => {
      const products = (await as('admin').get('/products?sort=sku:asc&pageSize=4').expect(200)).body
        .data as { id: string }[];
      const [a, b, c, d] = products;
      await setOnHand(a.id, str1, 20); // low; DC-NORTH has plenty → transfer
      await setOnHand(a.id, dcN, 500);
      await setOnHand(a.id, dcS, 0);
      await setOnHand(b.id, str1, 20); // low; no DC stock → purchase order
      await setOnHand(b.id, dcN, 0);
      await setOnHand(b.id, dcS, 0);
      await setOnHand(c.id, str2, 60); // fine at 4/day, short at 8/day
      await setOnHand(c.id, dcN, 300);
      await setOnHand(c.id, dcS, 0);
      await setOnHand(d.id, str2, 5000); // excess at any demand here
      await seedForecast([
        { product: a.id, location: str1, perDay: 10 },
        { product: b.id, location: str1, perDay: 10 },
        { product: c.id, location: str2, perDay: 4 },
        { product: d.id, location: str2, perDay: 1 },
      ]);
    });

    it('a zero scenario equals its baseline, and the same run twice gives the same summary', async () => {
      const s = await create(0, 0, 0, 'no change');
      const first = await run(s.id);
      expect(first.result).toEqual(first.baseline);
      expect(first.baseline.positions).toBe(4);
      expect(first.baseline.recommendations).toBeGreaterThan(0);
      const second = await run(s.id);
      expect(second.result).toEqual(first.result);
      expect(second.baseline).toEqual(first.baseline);
      expect(first.runBy).toBe('Imani Inventory');
      expect(first.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('running scenarios writes nothing but its result: stock, ledger, orders, recommendations untouched', async () => {
      const ids = [await create(50, 5, 100), await create(-50, 0, 0)].map((s) => s.id);
      const before = await untouched();
      const results = Number(
        (await db.query('SELECT count(*)::int AS n FROM scenario_results')).rows[0].n,
      );
      for (const id of ids) await run(id);
      expect(await untouched()).toEqual(before);
      expect((await db.query('SELECT count(*)::int AS n FROM scenario_results')).rows[0].n).toBe(
        results + 2,
      );
    });

    it('directions: more demand needs more; longer supplier lead times order more; no DC stock moves to orders', async () => {
      const more = await run((await create(100, 0, 0)).id);
      expect(more.result.recommendations).toBeGreaterThanOrEqual(more.baseline.recommendations);
      expect(more.result.units.TRANSFER + more.result.units.PURCHASE_ORDER).toBeGreaterThan(
        more.baseline.units.TRANSFER + more.baseline.units.PURCHASE_ORDER,
      );
      // C at STR-02: 60 units cover 4/day for 7+ days, not 8/day.
      expect(more.result.stockoutWithin14).toBeGreaterThan(more.baseline.stockoutWithin14);

      const slow = await run((await create(0, 5, 0)).id);
      expect(slow.result.units.PURCHASE_ORDER).toBeGreaterThan(slow.baseline.units.PURCHASE_ORDER);
      expect(slow.result.purchaseOrderValueAtCost).toBeGreaterThan(
        slow.baseline.purchaseOrderValueAtCost,
      );
      expect(slow.result.units.TRANSFER).toBe(slow.baseline.units.TRANSFER); // transfers unchanged

      const noDc = await run((await create(0, 0, 100)).id);
      expect(noDc.baseline.transfersFromDc).toBeGreaterThan(0);
      expect(noDc.result.transfersFromDc).toBe(0);
      expect(noDc.result.byAction.PURCHASE_ORDER).toBeGreaterThan(
        noDc.baseline.byAction.PURCHASE_ORDER,
      );
    });

    it('lists scenarios with their latest result, and shows every result of one', async () => {
      const list = (await as('analyst').get('/scenarios').expect(200)).body as {
        id: string;
        name: string;
        latestResult: unknown;
      }[];
      const noChange = list.find((s) => s.name === 'no change')!;
      expect(noChange.latestResult).toMatchObject({ scenarioId: noChange.id });
      const detail = (await as('analyst').get(`/scenarios/${noChange.id}`).expect(200)).body;
      expect(detail).toMatchObject({
        name: 'no change',
        demandPct: 0,
        supplierLeadTimeDays: 0,
        dcAvailabilityPct: 0,
        createdBy: 'Imani Inventory',
      });
      expect(detail.results).toHaveLength(2);
      expect(list.find((s) => s.name === 'before any forecast')!.latestResult).toBeNull();
    });
  });

  it('roles: approvers create and run, analysts read, store managers cannot see network results', async () => {
    const s = await create(10, 1, 10, 'roles');
    await as('analyst')
      .post('/scenarios', {
        name: 'x',
        demandPct: 0,
        supplierLeadTimeDays: 0,
        dcAvailabilityPct: 0,
      })
      .expect(403);
    await as('analyst').post(`/scenarios/${s.id}/run`).expect(403);
    await as('store1').get('/scenarios').expect(403);
    await as('store1').get(`/scenarios/${s.id}`).expect(403);
    await as('store1').post(`/scenarios/${s.id}/run`).expect(403);
    await http().get('/api/v1/scenarios').expect(401);
    await as('admin').get(`/scenarios/${randomUUID()}`).expect(404);
    await as('admin').post(`/scenarios/${randomUUID()}/run`).expect(404);
  });

  it('validates parameters and keeps scenarios immutable', async () => {
    for (const body of [
      { name: '', demandPct: 0, supplierLeadTimeDays: 0, dcAvailabilityPct: 0 },
      { name: 'x', demandPct: 201, supplierLeadTimeDays: 0, dcAvailabilityPct: 0 },
      { name: 'x', demandPct: -51, supplierLeadTimeDays: 0, dcAvailabilityPct: 0 },
      { name: 'x', demandPct: 10.5, supplierLeadTimeDays: 0, dcAvailabilityPct: 0 },
      { name: 'x', demandPct: 0, supplierLeadTimeDays: 31, dcAvailabilityPct: 0 },
      { name: 'x', demandPct: 0, supplierLeadTimeDays: 0, dcAvailabilityPct: 101 },
      { name: 'x', demandPct: 0, supplierLeadTimeDays: 0 },
    ]) {
      await as('admin').post('/scenarios', body).expect(400);
    }
    const s = await create(5, 0, 0, 'immutable');
    await expect(
      db.query(`UPDATE scenarios SET demand_pct = 6 WHERE id = $1`, [s.id]),
    ).rejects.toMatchObject({ code: '23001' });
  });
});
