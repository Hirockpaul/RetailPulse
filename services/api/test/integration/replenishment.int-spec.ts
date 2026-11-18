/**
 * Day 6: forecasts → recommendations → manager approval → transfer / purchase order.
 * The Python service is not involved: forecast rows are written straight into the `forecast`
 * schema (the Python side has its own tests), so every number here can be checked by hand.
 */
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { loadEnv } from '../../src/core/config/env';
import { ForecastClient } from '../../src/modules/forecasts/forecast.client';
import { DEMO, login } from './auth-helpers';
import { prepareTestDatabase, releaseTestDatabase } from './test-db';

let url: string;
let app: INestApplication;
let db: pg.Client;
const cookies = {} as Record<keyof typeof DEMO, string>;
const loc = {} as Record<'str1' | 'str2' | 'dcN' | 'dcS', string>;
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

const as = (who: keyof typeof DEMO, target: () => INestApplication = () => app) => ({
  get: (path: string) =>
    request(target().getHttpServer()).get(`/api/v1${path}`).set('Cookie', cookies[who]),
  post: (path: string, body: object = {}, key: string | null = null) => {
    const req = request(target().getHttpServer())
      .post(`/api/v1${path}`)
      .set('Cookie', cookies[who]);
    if (key !== null) req.set('Idempotency-Key', key);
    return req.send(body);
  },
});
const admin = () => as('admin');
const inv = () => as('inventory');

async function buildApp(overrides: { stubClient?: boolean } = {}): Promise<INestApplication> {
  // A closed port: the real client must NEVER reach a forecasting service that happens to run.
  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: url, FORECAST_URL: 'http://127.0.0.1:1' });
  let builder = Test.createTestingModule({ imports: [AppModule.forRoot(env)] });
  if (overrides.stubClient) {
    builder = builder.overrideProvider(ForecastClient).useValue({
      startRun: async (horizonDays?: number) => ({
        runId: 'stub-run',
        status: 'RUNNING',
        horizonDays,
      }),
    });
  }
  const instance = configureApp((await builder.compile()).createNestApplication({ logger: false }));
  await instance.init();
  return instance;
}

beforeAll(async () => {
  url = await prepareTestDatabase();
  app = await buildApp();
  db = new pg.Client({ connectionString: url });
  await db.connect();
  for (const who of Object.keys(DEMO) as (keyof typeof DEMO)[])
    cookies[who] = await login(app, DEMO[who]);
  const locations = (await admin().get('/locations?pageSize=100').expect(200)).body.data;
  const idOf = (code: string) => locations.find((l: { code: string }) => l.code === code).id;
  loc.str1 = idOf('STR-01');
  loc.str2 = idOf('STR-02');
  loc.dcN = idOf('DC-NORTH');
  loc.dcS = idOf('DC-SOUTH');
}, 60_000);

afterAll(async () => {
  await db?.end();
  await app?.close();
  await releaseTestDatabase();
});

// ------------------------------------------------------------------ helpers

interface Prod {
  id: string;
  sku: string;
  packSize: number;
}
async function product(sku: string): Promise<Prod> {
  const res = await admin().get(`/products?q=${sku}`).expect(200);
  return res.body.data.find((p: { sku: string }) => p.sku === sku);
}

async function stockRow(productId: string, location: string) {
  const rows = (await admin().get(`/products/${productId}/stock`).expect(200)).body.data;
  const row = rows.find((r: { locationId: string }) => r.locationId === location);
  return { onHand: (row?.onHand ?? 0) as number, inbound: (row?.inbound ?? 0) as number };
}

async function setOnHand(productId: string, location: string, target: number) {
  const { onHand } = await stockRow(productId, location);
  if (onHand !== target) {
    await admin()
      .post(
        '/adjustments',
        { productId, locationId: location, delta: target - onHand, reason: 'test setup' },
        randomUUID(),
      )
      .expect(201);
  }
}

interface SeriesSpec {
  product: string;
  location: string;
  perDay: number;
  sigma?: number;
  fallback?: boolean;
  model?: string;
  testWape?: number | null;
}

/** Write a finished forecast run (and its series/points/history) straight into the forecast schema. */
async function seedForecast(specs: SeriesSpec[], withMetrics = true): Promise<string> {
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
             current_date - 56, current_date - 29, current_date - 28, current_date - 1, $1, $2, $3,
             'moving_average_28 served: test fixture', false, ARRAY['mean_7d'])
     RETURNING id`,
    [specs.length, specs.filter((s) => s.fallback).length, mv.rows[0].id],
  );
  const runId = run.rows[0].id as string;
  for (const s of specs) {
    const sigma = s.sigma ?? 3;
    await db.query(
      `INSERT INTO forecast.series (run_id, product_id, location_id, history_days, model, is_fallback,
          avg_daily_28, std_daily_90, sigma, test_wape)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9)`,
      [
        runId,
        s.product,
        s.location,
        s.fallback ? 30 : 300,
        s.fallback ? 'category_average' : (s.model ?? 'moving_average_28'),
        s.fallback ?? false,
        s.perDay,
        sigma,
        s.testWape === undefined ? 0.31 : s.testWape,
      ],
    );
    await db.query(
      `INSERT INTO forecast.points (run_id, product_id, location_id, target_day, horizon_day, yhat, lower, upper)
       SELECT $1, $2, $3, current_date + h, h, $4::numeric, greatest($4::numeric - 2, 0), $4::numeric + 2
         FROM generate_series(1, 14) h`,
      [runId, s.product, s.location, s.perDay],
    );
    await db.query(
      `INSERT INTO forecast.demand_daily (product_id, location_id, day, units, source)
       SELECT $1, $2, current_date - d, $3::int, 'SYNTHETIC' FROM generate_series(1, 20) d
       ON CONFLICT DO NOTHING`,
      [s.product, s.location, Math.round(s.perDay)],
    );
  }
  if (withMetrics) {
    for (const [model, validation, test] of [
      ['moving_average_28', 0.42, 0.44],
      ['seasonal_naive_7', 0.55, 0.57],
      ['hgb_direct', 0.4, 0.46],
    ] as const) {
      for (const [split, wape] of [
        ['validation', validation],
        ['test', test],
      ] as const) {
        await db.query(
          `INSERT INTO forecast.model_metrics (run_id, model, split, mae, rmse, wape, n_points, n_series)
           VALUES ($1, $2, $3, 1.5, 2.1, $4, 1000, 40)`,
          [runId, model, split, wape],
        );
      }
    }
  }
  return runId;
}

const count = async (sql: string, params: unknown[] = []): Promise<number> =>
  (await db.query(sql, params)).rows[0].n;

/**
 * Independent re-statement of the formulas (see replenishment.calc.ts) for hand-checked cases,
 * with a flat forecast: SS = z × √(L·σe² + d²·σL²); z 1.6449 = 95 %, the level for products
 * that are not classified (nothing is classified in this file).
 */
const roundUp = (q: number, m: number) => Math.ceil(q / m) * m;
const orderQuantity = (a: {
  perDay: number;
  sigma: number;
  lead: number;
  sigmaLead?: number;
  position: number;
  pack: number;
  moq?: number;
}) => {
  const ss = 1.6449 * Math.sqrt(a.lead * a.sigma ** 2 + a.perDay ** 2 * (a.sigmaLead ?? 0) ** 2);
  const upTo = a.perDay * (a.lead + 7) + ss;
  const qty = roundUp(Math.ceil(upTo - a.position), a.pack);
  return a.moq === undefined ? qty : Math.max(qty, roundUp(a.moq, a.pack));
};

type Rec = {
  id: string;
  status: string;
  action: string;
  quantity: number;
  risk: string;
  sku: string;
  locationId: string;
  locationCode: string;
  sourceCode: string | null;
  supplierName: string | null;
  explanation: string;
  inputs: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  transferId: string | null;
  purchaseOrderId: string | null;
};
async function recFor(sku: string, location: string, status = 'PENDING'): Promise<Rec> {
  const list = (
    await admin().get(`/replenishment/recommendations?status=${status}&pageSize=100`).expect(200)
  ).body.data;
  const found = list.find((r: Rec) => r.sku === sku && r.locationId === location);
  if (!found) throw new Error(`No ${status} recommendation for ${sku} at ${location}`);
  return (await admin().get(`/replenishment/recommendations/${found.id}`).expect(200)).body;
}

// ------------------------------------------------------------------ no forecast yet

it('cannot generate recommendations before any forecast exists', async () => {
  const res = await inv().post('/replenishment/generate').expect(409);
  expect(res.body.error.code).toBe('NO_FORECAST');
  const overview = (await admin().get('/forecasts/runs/latest').expect(200)).body;
  expect(overview).toEqual({
    latest: null,
    current: null,
    metrics: [],
    ranges: [],
    importance: [],
  });
});

// ------------------------------------------------------------------ with a forecast

describe('recommendations from a forecast', () => {
  let A: Prod, B: Prod, C: Prod, D: Prod, E: Prod;
  let runId: string;
  let supplierTerms: {
    lead_time_days: number;
    min_order_qty: number;
    unit_cost: string;
    name: string;
  };
  /** The supplier's seeded delivery history: average delay and its spread (V2 2b). */
  let supplierDelay: { n: number; mean: number; sd: number };
  let generated: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const before: Record<string, number> = {};

  beforeAll(async () => {
    [A, B, C, D, E] = await Promise.all(
      ['RP-00100', 'RP-00101', 'RP-00102', 'RP-00103', 'RP-00104'].map(product),
    );
    // A @STR-01: low stock, DC-NORTH has plenty                     → transfer
    await setOnHand(A.id, loc.str1, 20);
    await setOnHand(A.id, loc.dcN, 500);
    await setOnHand(A.id, loc.dcS, 0);
    // B @STR-01: low stock, no distribution-centre stock             → purchase order
    await setOnHand(B.id, loc.str1, 20);
    await setOnHand(B.id, loc.dcN, 0);
    await setOnHand(B.id, loc.dcS, 0);
    // C @STR-01: plenty of stock                                     → nothing
    await setOnHand(C.id, loc.str1, 5000);
    // D: two stores need it, but DC-NORTH only has 100                → urgent store gets the DC stock
    await setOnHand(D.id, loc.str1, 20);
    await setOnHand(D.id, loc.str2, 5);
    await setOnHand(D.id, loc.dcN, 100);
    await setOnHand(D.id, loc.dcS, 0);
    // E @STR-01: new product (little history), no DC stock           → purchase order, flagged fallback
    await setOnHand(E.id, loc.str1, 5);
    await setOnHand(E.id, loc.dcN, 0);
    await setOnHand(E.id, loc.dcS, 0);

    supplierTerms = (
      await db.query(
        `SELECT sp.lead_time_days, sp.min_order_qty, sp.unit_cost::text, s.name
           FROM supplier_products sp JOIN suppliers s ON s.id = sp.supplier_id
          WHERE sp.product_id = $1 AND sp.is_primary`,
        [B.id],
      )
    ).rows[0];
    supplierDelay = (
      await db.query(
        `SELECT COUNT(*)::int AS n,
                AVG((d.received_on - d.ordered_on) - d.promised_days)::float8 AS mean,
                STDDEV_SAMP((d.received_on - d.ordered_on) - d.promised_days)::float8 AS sd
           FROM supplier_deliveries d
           JOIN supplier_products sp ON sp.supplier_id = d.supplier_id
          WHERE sp.product_id = $1 AND sp.is_primary`,
        [B.id],
      )
    ).rows[0];

    runId = await seedForecast([
      { product: A.id, location: loc.str1, perDay: 10 },
      { product: B.id, location: loc.str1, perDay: 10 },
      { product: C.id, location: loc.str1, perDay: 10 },
      { product: D.id, location: loc.str1, perDay: 10 },
      { product: D.id, location: loc.str2, perDay: 10 },
      { product: E.id, location: loc.str1, perDay: 10, fallback: true, testWape: null },
    ]);

    for (const t of ['stock_transfers', 'purchase_orders', 'inventory_ledger', 'outbox_events']) {
      before[t] = await count(`SELECT COUNT(*)::int AS n FROM ${t}`);
    }
    generated = (await inv().post('/replenishment/generate').expect(200)).body;
  }, 60_000);

  it('reports what it evaluated, created and skipped', () => {
    expect(generated).toMatchObject({
      forecastRunId: runId,
      evaluated: 6,
      created: 5, // A, B, D@STR-01, D@STR-02, E
      expired: 0,
      skipped: { noNeed: 1, noSource: 0 }, // C has plenty of stock
    });
    expect(generated.byAction.TRANSFER + generated.byAction.PURCHASE_ORDER).toBe(5);
    expect(generated.byRisk.CRITICAL + generated.byRisk.HIGH).toBe(5);
  });

  it('generating creates NO transfers, orders, stock movements or events', async () => {
    for (const t of ['stock_transfers', 'purchase_orders', 'inventory_ledger', 'outbox_events']) {
      expect(await count(`SELECT COUNT(*)::int AS n FROM ${t}`)).toBe(before[t]);
    }
    const all = (await admin().get('/replenishment/recommendations?pageSize=100').expect(200)).body;
    expect(all.data.every((r: Rec) => r.status === 'PENDING')).toBe(true);
  });

  it('suggests a transfer from the distribution centre with a hand-checked quantity', async () => {
    const r = await recFor(A.sku, loc.str1);
    expect(r).toMatchObject({ action: 'TRANSFER', sourceCode: 'DC-NORTH', supplierName: null });
    expect(r.quantity).toBe(
      orderQuantity({ perDay: 10, sigma: 3, lead: 2, position: 20, pack: A.packSize }),
    );
    expect(r.quantity % A.packSize).toBe(0);
    expect(r.risk).toBe('HIGH'); // 20 units last exactly the 2-day transfer lead time
  });

  it('suggests a purchase order from the primary supplier when no DC has stock', async () => {
    const r = await recFor(B.sku, loc.str1);
    expect(r).toMatchObject({ action: 'PURCHASE_ORDER', sourceCode: null });
    expect(r.supplierName).toBe(supplierTerms.name);
    // The seed gives every supplier a year of deliveries, so the measured delay applies (V2 2b).
    expect(supplierDelay.n).toBeGreaterThanOrEqual(20);
    const lead = supplierTerms.lead_time_days + supplierDelay.mean;
    expect(r.inputs.parameters).toMatchObject({
      leadTimeBasis: 'measured',
      supplierDeliveries: supplierDelay.n,
      serviceLevel: 0.95,
      classification: { cls: null, runId: null },
    });
    expect(r.inputs.parameters.leadTimeDays).toBeCloseTo(lead, 9);
    expect(r.inputs.parameters.leadTimeStdDays).toBeCloseTo(supplierDelay.sd, 9);
    expect(r.inputs.supplier.leadTimeDays).toBe(supplierTerms.lead_time_days); // order's promise
    expect(r.explanation).toContain(
      `${supplierTerms.lead_time_days} promised + ${Math.round(supplierDelay.mean * 10) / 10} average delay over ${supplierDelay.n} recorded deliveries`,
    );
    expect(r.quantity).toBe(
      orderQuantity({
        perDay: 10,
        sigma: 3,
        lead,
        sigmaLead: supplierDelay.sd,
        position: 20,
        pack: B.packSize,
        moq: supplierTerms.min_order_qty,
      }),
    );
    expect(r.quantity).toBeGreaterThanOrEqual(roundUp(supplierTerms.min_order_qty, B.packSize));
    expect(r.quantity % B.packSize).toBe(0);
  });

  it('suggests nothing for a product with plenty of stock', async () => {
    const list = (await admin().get(`/replenishment/recommendations?productId=${C.id}`).expect(200))
      .body;
    expect(list.total).toBe(0);
  });

  it('never promises the same distribution-centre stock twice; the most urgent store gets it', async () => {
    const urgent = await recFor(D.sku, loc.str2); // 5 units: the most urgent
    const other = await recFor(D.sku, loc.str1); // 20 units
    expect(urgent).toMatchObject({ action: 'TRANSFER', sourceCode: 'DC-NORTH', risk: 'CRITICAL' });
    expect(urgent.quantity).toBe(
      orderQuantity({ perDay: 10, sigma: 3, lead: 2, position: 5, pack: D.packSize }),
    );
    expect(urgent.quantity).toBeLessThanOrEqual(100);

    const left = 100 - urgent.quantity; // what remains at DC-NORTH for the next store
    expect(other.action).toBe('PURCHASE_ORDER');
    expect(other.inputs.dcShortfall).toMatchObject({ code: 'DC-NORTH', availableNet: left });
    expect(other.explanation).toContain(`DC-NORTH has ${left}`);
    // The two transfers can never ask for more than the centre holds.
    expect(urgent.quantity).toBeLessThanOrEqual(100);
  });

  it('flags forecasts that are only a category-average fallback', async () => {
    const r = await recFor(E.sku, loc.str1);
    expect(r.action).toBe('PURCHASE_ORDER');
    expect(r.inputs.forecast).toMatchObject({
      isFallback: true,
      model: 'category_average',
      testWape: null,
    });
    expect(r.explanation).toContain('category-average fallback');
  });

  it('explains every recommendation with the numbers, and stores every input', async () => {
    const r = await recFor(A.sku, loc.str1);
    expect(r.explanation).toContain(`${A.sku} at STR-01 over the next 2 days: 20 units`);
    expect(r.explanation).toContain(
      'Service level 95 % (not classified yet: default) → z = 1.6449',
    );
    expect(r.explanation).toContain('= 1.6449 × √(2 × 3² + 10² × 0²) = 7');
    expect(r.explanation).toContain('20 available + 0 inbound = 20');
    expect(r.explanation).toContain(`rounded up to packs of ${A.packSize} = ${r.quantity} units`);
    expect(r.explanation).toContain('transfer from DC-NORTH');
    expect(r.inputs).toMatchObject({
      forecast: {
        runId,
        model: 'moving_average_28',
        isFallback: false,
        demandDuringLead: 20,
        sigmaError: 3,
      },
      parameters: {
        serviceLevel: 0.95,
        serviceLevelZ: 1.6449,
        reviewPeriodDays: 7,
        leadTimeDays: 2,
        leadTimeSource: 'transfer',
        leadTimeStdDays: 0,
        leadTimeBasis: 'transfer',
        supplierDeliveries: null,
        packSize: A.packSize,
      },
      stock: { onHand: 20, reserved: 0, available: 20, inbound: 0, position: 20 },
      calculation: { quantity: r.quantity, daysOfCover: 2 },
      source: { code: 'DC-NORTH' },
      supplier: null,
    });
    expect(r.inputs.calculation.safetyStock).toBeCloseTo(1.6449 * 3 * Math.sqrt(2), 9); // 6.979
    expect(r.inputs.calculation.reorderPoint).toBeCloseTo(26.979, 3);
    expect(r.inputs.calculation.safetyStockParts).toEqual({
      demandVariance: 18,
      leadTimeVariance: 0,
    });
  });

  it('lists the most urgent first and supports filters and pagination', async () => {
    const all = (await admin().get('/replenishment/recommendations?pageSize=100').expect(200)).body;
    expect(all.total).toBe(5);
    expect(all.data[0].risk).toBe('CRITICAL'); // critical risks lead
    expect(all.data[0]).not.toHaveProperty('inputs'); // summaries stay small

    const transfers = (
      await admin().get('/replenishment/recommendations?action=TRANSFER').expect(200)
    ).body;
    expect(transfers.data.every((r: Rec) => r.action === 'TRANSFER')).toBe(true);
    const critical = (await admin().get('/replenishment/recommendations?risk=CRITICAL').expect(200))
      .body;
    expect(critical.data.every((r: Rec) => r.risk === 'CRITICAL')).toBe(true);
    const page = (await admin().get('/replenishment/recommendations?pageSize=2&page=3').expect(200))
      .body;
    expect(page).toMatchObject({ total: 5, page: 3, pageSize: 2 });
    expect(page.data).toHaveLength(1);
    await admin().get('/replenishment/recommendations?risk=LOW').expect(400);
    await admin().get(`/replenishment/recommendations/${MISSING_ID}`).expect(404);
  });

  it('shows store managers only their own stores', async () => {
    const mine = (await as('store1').get('/replenishment/recommendations?pageSize=100').expect(200))
      .body;
    expect(new Set(mine.data.map((r: Rec) => r.locationCode))).toEqual(new Set(['STR-01']));
    const theirs = (
      await as('store2').get('/replenishment/recommendations?pageSize=100').expect(200)
    ).body;
    expect(new Set(theirs.data.map((r: Rec) => r.locationCode))).toEqual(new Set(['STR-02']));

    await as('store1').get(`/replenishment/recommendations?locationId=${loc.str2}`).expect(403);
    const str2Rec = await recFor(D.sku, loc.str2);
    await as('store1').get(`/replenishment/recommendations/${str2Rec.id}`).expect(403);
    await as('store2').get(`/replenishment/recommendations/${str2Rec.id}`).expect(200);
    await as('analyst').get(`/replenishment/recommendations/${str2Rec.id}`).expect(200);
  });

  it('only admins and inventory managers can generate, approve or reject', async () => {
    const r = await recFor(E.sku, loc.str1);
    for (const who of ['store1', 'analyst'] as const) {
      await as(who).post('/replenishment/generate').expect(403);
      await as(who).post(`/replenishment/recommendations/${r.id}/approve`).expect(403);
      await as(who).post(`/replenishment/recommendations/${r.id}/reject`).expect(403);
      await as(who).post('/forecasts/run', {}).expect(403);
    }
    expect((await recFor(E.sku, loc.str1)).status).toBe('PENDING'); // untouched
  });

  // ---- approval: the only thing that creates a transfer or an order

  it('approving a transfer recommendation creates an APPROVED transfer, and moves no stock yet', async () => {
    const r = await recFor(A.sku, loc.str1);
    const dcBefore = (await stockRow(A.id, loc.dcN)).onHand;
    const storeBefore = await stockRow(A.id, loc.str1);
    const transfersBefore = await count('SELECT COUNT(*)::int AS n FROM stock_transfers');

    const res = await inv()
      .post(`/replenishment/recommendations/${r.id}/approve`, { note: 'go ahead' })
      .expect(200);
    expect(res.body).toMatchObject({
      status: 'APPROVED',
      decidedBy: 'Imani Inventory',
      decisionNote: 'go ahead',
      purchaseOrderId: null,
    });
    expect(res.body.decidedAt).toEqual(expect.any(String));
    expect(await count('SELECT COUNT(*)::int AS n FROM stock_transfers')).toBe(transfersBefore + 1);

    const transfer = (await admin().get(`/transfers/${res.body.transferId}`).expect(200)).body;
    expect(transfer).toMatchObject({
      status: 'APPROVED', // approving the recommendation is the transfer's approval
      sourceCode: 'DC-NORTH',
      destinationCode: 'STR-01',
      requestedBy: 'Imani Inventory',
      approvedBy: 'Imani Inventory',
      lines: [{ sku: A.sku, quantity: r.quantity }],
    });
    expect(transfer.notes).toContain(r.id);

    // No stock has moved; the units now show as inbound at the store.
    expect((await stockRow(A.id, loc.dcN)).onHand).toBe(dcBefore);
    expect(await stockRow(A.id, loc.str1)).toEqual({
      onHand: storeBefore.onHand,
      inbound: r.quantity,
    });

    // The normal transfer flow takes over.
    await admin().post(`/transfers/${transfer.id}/dispatch`).expect(201);
    await admin().post(`/transfers/${transfer.id}/receive`).expect(201);
    expect(await stockRow(A.id, loc.str1)).toEqual({
      onHand: storeBefore.onHand + r.quantity,
      inbound: 0,
    });
    expect((await stockRow(A.id, loc.dcN)).onHand).toBe(dcBefore - r.quantity);
  });

  it('approving a purchase-order recommendation creates an APPROVED order; receiving it adds the stock', async () => {
    const r = await recFor(B.sku, loc.str1);
    const before = await stockRow(B.id, loc.str1);
    const res = await inv().post(`/replenishment/recommendations/${r.id}/approve`).expect(200);
    expect(res.body).toMatchObject({ status: 'APPROVED', transferId: null });

    const po = (await admin().get(`/purchase-orders/${res.body.purchaseOrderId}`).expect(200)).body;
    const expectedDate = (
      await db.query(`SELECT ((now() AT TIME ZONE 'UTC')::date + $1::int)::text AS d`, [
        supplierTerms.lead_time_days,
      ])
    ).rows[0].d;
    expect(po).toMatchObject({
      status: 'APPROVED',
      supplierName: supplierTerms.name,
      destinationCode: 'STR-01',
      expectedDate,
      createdBy: 'Imani Inventory',
      lineCount: 1,
      totalUnits: r.quantity,
      lines: [{ sku: B.sku, quantity: r.quantity, unitCost: supplierTerms.unit_cost }],
    });
    expect(Number(po.totalCost)).toBeCloseTo(r.quantity * Number(supplierTerms.unit_cost), 2);

    // Ordered but not here yet: shows as inbound, on-hand unchanged.
    expect(await stockRow(B.id, loc.str1)).toEqual({ onHand: before.onHand, inbound: r.quantity });

    // Another store's manager cannot receive it; the destination store's manager can.
    await as('store2').post(`/purchase-orders/${po.id}/receive`).expect(403);
    await as('analyst').post(`/purchase-orders/${po.id}/receive`).expect(403);
    const received = await as('store1').post(`/purchase-orders/${po.id}/receive`).expect(201);
    expect(received.body).toMatchObject({ status: 'RECEIVED', receivedBy: 'Sam Store-One' });

    expect(await stockRow(B.id, loc.str1)).toEqual({
      onHand: before.onHand + r.quantity,
      inbound: 0,
    });
    const { rows } = await db.query(
      `SELECT e.movement_type, e.on_hand_delta, e.reference_type, e.reference_id, u.email
         FROM inventory_ledger e JOIN users u ON u.id = e.actor_id
        WHERE e.reference_id = $1`,
      [po.id],
    );
    expect(rows).toEqual([
      {
        movement_type: 'RECEIPT',
        on_hand_delta: r.quantity,
        reference_type: 'PURCHASE_ORDER',
        reference_id: po.id,
        email: DEMO.store1,
      },
    ]);

    // Receiving twice, or cancelling a received order, is refused.
    await inv().post(`/purchase-orders/${po.id}/receive`).expect(409);
    const cancel = await inv().post(`/purchase-orders/${po.id}/cancel`).expect(409);
    expect(cancel.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('cancelling an unreceived order is for admins and inventory managers and adds no stock', async () => {
    const r = await recFor(E.sku, loc.str1);
    const po = (await inv().post(`/replenishment/recommendations/${r.id}/approve`).expect(200)).body
      .purchaseOrderId;
    const before = await stockRow(E.id, loc.str1);
    expect(before.inbound).toBe(r.quantity);

    await as('store1').post(`/purchase-orders/${po}/cancel`).expect(403);
    const cancelled = await inv().post(`/purchase-orders/${po}/cancel`).expect(201);
    expect(cancelled.body).toMatchObject({ status: 'CANCELLED', cancelledBy: 'Imani Inventory' });
    expect(await stockRow(E.id, loc.str1)).toEqual({ onHand: before.onHand, inbound: 0 });
    await inv().post(`/purchase-orders/${po}/receive`).expect(409);
  });

  it('rejecting records the decision and creates nothing', async () => {
    const r = await recFor(D.sku, loc.str1);
    const docs =
      (await count('SELECT COUNT(*)::int AS n FROM stock_transfers')) +
      (await count('SELECT COUNT(*)::int AS n FROM purchase_orders'));
    const res = await inv()
      .post(`/replenishment/recommendations/${r.id}/reject`, { note: 'overstocked next week' })
      .expect(200);
    expect(res.body).toMatchObject({
      status: 'REJECTED',
      decidedBy: 'Imani Inventory',
      decisionNote: 'overstocked next week',
      transferId: null,
      purchaseOrderId: null,
    });
    expect(
      (await count('SELECT COUNT(*)::int AS n FROM stock_transfers')) +
        (await count('SELECT COUNT(*)::int AS n FROM purchase_orders')),
    ).toBe(docs);
    await inv().post(`/replenishment/recommendations/${r.id}/approve`).expect(409);
    await inv().post(`/replenishment/recommendations/${r.id}/reject`).expect(409);
  });

  it('five simultaneous approvals create exactly one document', async () => {
    const r = await recFor(D.sku, loc.str2);
    const docs =
      (await count('SELECT COUNT(*)::int AS n FROM stock_transfers')) +
      (await count('SELECT COUNT(*)::int AS n FROM purchase_orders'));
    const results = await Promise.all(
      Array.from({ length: 5 }, () => inv().post(`/replenishment/recommendations/${r.id}/approve`)),
    );
    expect(results.filter((x) => x.status === 200)).toHaveLength(1);
    const refused = results.filter((x) => x.status === 409);
    expect(refused).toHaveLength(4);
    expect(refused.every((x) => x.body.error.code === 'INVALID_STATE_TRANSITION')).toBe(true);
    expect(
      (await count('SELECT COUNT(*)::int AS n FROM stock_transfers')) +
        (await count('SELECT COUNT(*)::int AS n FROM purchase_orders')),
    ).toBe(docs + 1);
  });

  it('V2 2b: the service level follows the product’s ABC/XYZ class at the store', async () => {
    const [P1, P2, P3] = await Promise.all(['RP-00131', 'RP-00132', 'RP-00133'].map(product));
    for (const p of [P1, P2, P3]) {
      await setOnHand(p.id, loc.str1, 5);
      await setOnHand(p.id, loc.dcN, 500);
    }
    // A classification run: P1 is AX and P2 is CZ at STR-01; P3 is AX network-wide only.
    const run = (
      await db.query(
        `INSERT INTO classification_runs (window_start, window_end, data_label, item_count)
         VALUES (current_date - 364, current_date - 1, 'SYNTHETIC', 3) RETURNING id`,
      )
    ).rows[0].id as string;
    for (const [p, location, abc, xyz] of [
      [P1.id, loc.str1, 'A', 'X'],
      [P2.id, loc.str1, 'C', 'Z'],
      [P3.id, null, 'A', 'X'],
    ]) {
      await db.query(
        `INSERT INTO inventory_classifications (run_id, product_id, location_id, weeks_observed, units,
            value, value_share, cumulative_share, weekly_mean, cv, adi, abc, xyz, cls)
         VALUES ($1, $2, $3, 52, 520, 100, 0.1, 0.1, 10, 0.3, 1, $4, $5, $6)`,
        [run, p, location, abc, xyz, `${abc}${xyz}`],
      );
    }
    try {
      await seedForecast(
        [P1, P2, P3].map((p) => ({ product: p.id, location: loc.str1, perDay: 10 })),
      );
      await inv().post('/replenishment/generate').expect(200);
      const [r1, r2, r3] = await Promise.all([P1, P2, P3].map((p) => recFor(p.sku, loc.str1)));

      expect(r1.inputs.parameters).toMatchObject({
        serviceLevel: 0.99,
        serviceLevelZ: 2.3263,
        classification: { cls: 'AX', runId: run },
      });
      expect(r1.inputs.calculation.safetyStock).toBeCloseTo(2.3263 * 3 * Math.sqrt(2), 9);
      expect(r1.explanation).toContain('Service level 99 % (class AX at STR-01) → z = 2.3263');

      expect(r2.inputs.parameters).toMatchObject({ serviceLevel: 0.9, serviceLevelZ: 1.2816 });
      expect(r2.inputs.calculation.safetyStock).toBeCloseTo(1.2816 * 3 * Math.sqrt(2), 9);

      // Only the class AT THE STORE counts; a network-wide class alone gives the default.
      expect(r3.inputs.parameters).toMatchObject({
        serviceLevel: 0.95,
        classification: { cls: null, runId: run },
      });
      // Leave nothing pending for the tests below.
      for (const r of [r1, r2, r3]) {
        await inv().post(`/replenishment/recommendations/${r.id}/reject`).expect(200);
      }
    } finally {
      await db.query('DELETE FROM classification_runs WHERE id = $1', [run]);
    }
  });

  it('regenerating replaces the pending recommendations (old ones expire) and counts inbound stock', async () => {
    // Everything has been decided by now, so nothing is pending any more.
    expect(
      (await admin().get('/replenishment/recommendations?status=PENDING').expect(200)).body.total,
    ).toBe(0);
    await seedForecast([
      { product: A.id, location: loc.str1, perDay: 10 },
      { product: B.id, location: loc.str1, perDay: 10 },
    ]);
    // A and B were replenished above, so their stock is now healthy.
    const first = (await inv().post('/replenishment/generate').expect(200)).body;
    expect(first.expired).toBe(0);

    // Make A short again, generate twice: the first pending suggestion must expire, not duplicate.
    await setOnHand(A.id, loc.str1, 3);
    const second = (await inv().post('/replenishment/generate').expect(200)).body;
    const third = (await inv().post('/replenishment/generate').expect(200)).body;
    expect(second.created).toBeGreaterThanOrEqual(1);
    expect(third.expired).toBe(second.created);
    const pendingForA = (
      await admin()
        .get(`/replenishment/recommendations?productId=${A.id}&status=PENDING`)
        .expect(200)
    ).body;
    expect(pendingForA.total).toBe(1);
    const expired = (
      await admin()
        .get(`/replenishment/recommendations?productId=${A.id}&status=EXPIRED`)
        .expect(200)
    ).body;
    expect(expired.total).toBeGreaterThanOrEqual(1);
    await inv().post(`/replenishment/recommendations/${expired.data[0].id}/approve`).expect(409); // expired = final

    // Stock already on its way counts: approve it and generate again, nothing more is suggested.
    await inv()
      .post(`/replenishment/recommendations/${pendingForA.data[0].id}/approve`)
      .expect(200);
    const afterApproval = (await inv().post('/replenishment/generate').expect(200)).body;
    const stillForA = (
      await admin()
        .get(`/replenishment/recommendations?productId=${A.id}&status=PENDING`)
        .expect(200)
    ).body;
    expect(stillForA.total).toBe(0);
    expect(afterApproval.skipped.noNeed).toBeGreaterThanOrEqual(1);
  });

  it('concurrent generates do not clash', async () => {
    const results = await Promise.all([1, 2, 3].map(() => inv().post('/replenishment/generate')));
    expect(results.map((x) => x.status)).toEqual([200, 200, 200]);
  });
});

// ------------------------------------------------------------------ forecasts API

describe('forecasts API', () => {
  let P: Prod;
  let runId: string;

  beforeAll(async () => {
    P = await product('RP-00110');
    runId = await seedForecast([
      {
        product: P.id,
        location: loc.str2,
        perDay: 6,
        sigma: 2.5,
        model: 'hgb_direct',
        testWape: 0.28,
      },
    ]);
  });

  it('shows the current run with the accuracy of every model on validation and test', async () => {
    const res = (await as('analyst').get('/forecasts/runs/latest').expect(200)).body;
    expect(res.current).toMatchObject({
      id: runId,
      status: 'SUCCEEDED',
      dataLabel: 'SYNTHETIC',
      horizonDays: 14,
      servedModel: 'moving_average_28',
      selectionReason: expect.stringContaining('served'),
      mlBeatBaseline: false,
    });
    expect(res.current.historyEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.metrics).toHaveLength(6);
    const ml = res.metrics.find((m: any) => m.model === 'hgb_direct' && m.split === 'test'); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(ml).toMatchObject({ wape: '0.4600', nPoints: 1000, nSeries: 40 });
  });

  it('returns history, forecast, interval and accuracy for one product at one store', async () => {
    const res = (
      await as('store2')
        .get(`/forecasts/series?productId=${P.id}&locationId=${loc.str2}`)
        .expect(200)
    ).body;
    expect(res).toMatchObject({
      run: { id: runId, dataLabel: 'SYNTHETIC' },
      model: 'hgb_direct',
      isFallback: false,
      historyDays: 300,
      avgDaily28: 6,
      stdDaily90: 2.5,
      sigma: 2.5,
      testWape: 0.28,
    });
    expect(res.history).toHaveLength(20);
    expect(res.history[0].day < res.history[19].day).toBe(true); // oldest first
    expect(res.points).toHaveLength(14);
    expect(res.points[0]).toMatchObject({ horizonDay: 1, yhat: 6, lower: 4, upper: 8 });
    // Runs written before V2 step 1b have no 95 % range and no calibration: reported as such.
    expect(res.points[0]).toMatchObject({ lower95: null, upper95: null });
    expect(res.ranges).toEqual([]);
  });

  it('V2 1b: returns the 95 % range, bias, range coverage and the calibration per sales level', async () => {
    await db.query(
      `UPDATE forecast.points SET lower95 = greatest(lower - 1, 0), upper95 = upper + 1.5
        WHERE run_id = $1`,
      [runId],
    );
    await db.query(
      `UPDATE forecast.model_metrics SET bias = 0.012, interval_coverage = 0.81,
              interval_width = 4.9, interval95_coverage = 0.948, interval95_width = 7.4
        WHERE run_id = $1 AND split = 'test'`,
      [runId],
    );
    await db.query(
      `INSERT INTO forecast.interval_calibration (run_id, level, group_index, forecast_from,
          forecast_to, q_low, q_high, n_calibration, pooled, test_coverage, test_points)
       VALUES ($1, 80, 0, 0, 4, -1.2, 1.8, 900, false, 0.79, 450),
              ($1, 80, 1, 4, NULL, -3.1, 4.4, 300, false, 0.82, 150),
              ($1, 95, 0, 0, 4, -2, 3.2, 900, false, 0.95, 450),
              ($1, 95, 1, 4, NULL, -5, 7.1, 300, false, 0.94, 150)`,
      [runId],
    );
    const latest = (await as('analyst').get('/forecasts/runs/latest').expect(200)).body;
    const ml = latest.metrics.find((m: any) => m.model === 'hgb_direct' && m.split === 'test'); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(ml).toMatchObject({
      bias: '0.0120',
      intervalCoverage: '0.8100',
      intervalWidth: '4.9000',
      interval95Coverage: '0.9480',
      interval95Width: '7.4000',
    });
    expect(latest.ranges).toHaveLength(4);
    expect(latest.ranges[1]).toEqual({
      level: 80,
      forecastFrom: 4,
      forecastTo: null,
      qLow: -3.1,
      qHigh: 4.4,
      testCoverage: 0.82,
      testPoints: 150,
    });

    const series = (
      await as('store2')
        .get(`/forecasts/series?productId=${P.id}&locationId=${loc.str2}`)
        .expect(200)
    ).body;
    expect(series.points[0]).toMatchObject({ lower: 4, upper: 8, lower95: 3, upper95: 9.5 });
    expect(series.ranges).toHaveLength(4);
  });

  it('V2 1b: the database refuses a 95 % range that does not contain the 80 % range', async () => {
    await expect(
      db.query(`UPDATE forecast.points SET lower95 = lower + 0.5 WHERE run_id = $1`, [runId]),
    ).rejects.toThrow(/points_ranges_nested/);
  });

  it('V2 1c: explains the forecast as factors that multiply back to it, or says why it cannot', async () => {
    const url = `/forecasts/explanation?productId=${P.id}&locationId=${loc.str2}`;
    // A run made before explanations existed.
    let res = (await as('store2').get(url).expect(200)).body;
    expect(res).toMatchObject({ status: 'NOT_AVAILABLE', explanation: null, globalImportance: [] });

    await db.query(`UPDATE forecast.runs SET explanation_status = 'NOT_ML' WHERE id = $1`, [runId]);
    res = (await as('analyst').get(url).expect(200)).body;
    expect(res).toMatchObject({
      status: 'NOT_ML',
      servedModel: 'moving_average_28',
      explanation: null,
    });

    const contributions = [
      { feature: 'mean_56d', value: 6.2, contribution: Math.log(1.5) },
      { feature: 'weekday', value: 5, contribution: Math.log(1.2) },
      { feature: 'store', value: 1, contribution: Math.log(0.9) },
      { feature: 'season', value: 322, contribution: 0 },
    ];
    const baseLog = Math.log(3);
    const forecast = 3 * 1.5 * 1.2 * 0.9;
    await db.query(`UPDATE forecast.runs SET explanation_status = 'OK' WHERE id = $1`, [runId]);
    await db.query(
      `INSERT INTO forecast.explanations (run_id, product_id, location_id, horizon_day, base_log,
          forecast, contributions) VALUES ($1, $2, $3, 1, $4, $5, $6)`,
      [runId, P.id, loc.str2, baseLog, forecast, JSON.stringify(contributions)],
    );
    await db.query(
      `INSERT INTO forecast.feature_importance (run_id, feature, mean_abs_contribution, rank)
       VALUES ($1, 'mean_56d', 0.58, 1), ($1, 'weekday', 0.12, 2)`,
      [runId],
    );
    res = (await as('store2').get(url).expect(200)).body;
    expect(res.status).toBe('OK');
    const e = res.explanation;
    expect(e.startingPoint).toBeCloseTo(3, 5); // base_log is stored with 6 decimals
    expect(e.forecast).toBeCloseTo(4.86, 4);
    const product = e.factors.reduce((p: number, f: { factor: number }) => p * f.factor, 1);
    expect(e.startingPoint * product).toBeCloseTo(e.forecast, 4); // factors multiply back exactly
    expect(e.factors.map((f: { label: string; display: string }) => [f.label, f.display])).toEqual([
      ['Average sales, last 56 days', '6.2 per day'],
      ['Day of the week', 'Saturday'],
      ['Store', 'STR-02'],
      ['Time of year', 'November'],
    ]);
    const historyEnd = (await admin().get('/forecasts/runs/latest').expect(200)).body.current
      .historyEnd as string;
    const next = new Date(`${historyEnd}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    expect(e.targetDay).toBe(next.toISOString().slice(0, 10)); // explains the first forecast day
    const latestRun = (await as('analyst').get('/forecasts/runs/latest').expect(200)).body;
    expect(latestRun.importance.map((i: { label: string }) => i.label)).toEqual([
      'Average sales, last 56 days',
      'Day of the week',
    ]);
    expect(res.globalImportance).toEqual([
      {
        feature: 'mean_56d',
        label: 'Average sales, last 56 days',
        meanAbsContribution: 0.58,
        rank: 1,
      },
      { feature: 'weekday', label: 'Day of the week', meanAbsContribution: 0.12, rank: 2 },
    ]);
  });

  it('V2 1c: explanations respect store scope and need an existing forecast', async () => {
    await as('store1')
      .get(`/forecasts/explanation?productId=${P.id}&locationId=${loc.str2}`)
      .expect(403);
    await admin()
      .get(`/forecasts/explanation?productId=${P.id}&locationId=${loc.str1}`)
      .expect(404);
    await admin().get('/forecasts/explanation?productId=nope').expect(400);
  });

  it('respects store scope and reports missing forecasts', async () => {
    await as('store1')
      .get(`/forecasts/series?productId=${P.id}&locationId=${loc.str2}`)
      .expect(403);
    await admin().get(`/forecasts/series?productId=${P.id}&locationId=${loc.str1}`).expect(404);
    await admin()
      .get(`/forecasts/series?productId=${MISSING_ID}&locationId=${loc.str2}`)
      .expect(404);
    await admin().get('/forecasts/series?productId=nope').expect(400);
  });

  it('starting a run needs the forecasting service; a missing service is a clear 503', async () => {
    const res = await inv().post('/forecasts/run', { horizonDays: 7 }).expect(503);
    expect(res.body.error.code).toBe('FORECAST_SERVICE_UNAVAILABLE');
    await inv().post('/forecasts/run', { horizonDays: 99 }).expect(400);
  });

  it('with the service available, a run starts and answers 202', async () => {
    const stubbed = await buildApp({ stubClient: true });
    try {
      const res = await as('inventory', () => stubbed)
        .post('/forecasts/run', { horizonDays: 7 })
        .expect(202);
      expect(res.body).toMatchObject({ runId: 'stub-run', status: 'RUNNING', horizonDays: 7 });
    } finally {
      await stubbed.close();
    }
  });
});

// ------------------------------------------------------------------ database guarantees

describe('database guarantees', () => {
  async function pending(): Promise<{ id: string; product_id: string; location_id: string }> {
    const rows = (
      await db.query(
        `SELECT id, product_id, location_id FROM replenishment_recommendations WHERE status = 'PENDING' LIMIT 1`,
      )
    ).rows;
    if (rows.length) return rows[0];
    // make one if everything was decided
    const p = await product('RP-00120');
    await setOnHand(p.id, loc.str1, 1);
    await setOnHand(p.id, loc.dcN, 0);
    await setOnHand(p.id, loc.dcS, 0);
    await seedForecast([{ product: p.id, location: loc.str1, perDay: 10 }]);
    await inv().post('/replenishment/generate').expect(200);
    return (
      await db.query(
        `SELECT id, product_id, location_id FROM replenishment_recommendations WHERE status = 'PENDING' LIMIT 1`,
      )
    ).rows[0];
  }

  it('only one pending recommendation per product and store', async () => {
    const r = await pending();
    await expect(
      db.query(
        `INSERT INTO replenishment_recommendations
           (forecast_run_id, product_id, location_id, action, supplier_id, quantity, risk, inputs, explanation)
         SELECT forecast_run_id, product_id, location_id, action, supplier_id, quantity, risk, inputs, explanation
           FROM replenishment_recommendations WHERE id = $1`,
        [r.id],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('decisions are final and an approval must point at exactly one document', async () => {
    const r = await pending();
    await db.query('BEGIN');
    await expect(
      db.query(`UPDATE replenishment_recommendations SET status = 'APPROVED' WHERE id = $1`, [
        r.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' }); // no decider, no document
    await db.query('ROLLBACK');

    const decided = (
      await db.query(
        `SELECT id FROM replenishment_recommendations WHERE status = 'REJECTED' LIMIT 1`,
      )
    ).rows[0];
    await db.query('BEGIN');
    await expect(
      db.query(`UPDATE replenishment_recommendations SET status = 'PENDING' WHERE id = $1`, [
        decided.id,
      ]),
    ).rejects.toMatchObject({ code: '23001' });
    await db.query('ROLLBACK');
  });

  it('a recommendation is either a transfer (with a source) or an order (with a supplier)', async () => {
    const r = await pending();
    await db.query('BEGIN');
    await expect(
      db.query(
        `UPDATE replenishment_recommendations SET source_location_id = $2, supplier_id = supplier_id WHERE id = $1`,
        [r.id, loc.dcN],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'recommendation_action_fields' });
    await db.query('ROLLBACK');
  });

  it('purchase orders only move APPROVED → RECEIVED or CANCELLED, with matching timestamps', async () => {
    const received = (
      await db.query(`SELECT id FROM purchase_orders WHERE status = 'RECEIVED' LIMIT 1`)
    ).rows[0];
    await db.query('BEGIN');
    await expect(
      db.query(`UPDATE purchase_orders SET status = 'APPROVED' WHERE id = $1`, [received.id]),
    ).rejects.toMatchObject({ code: '23001' });
    await db.query('ROLLBACK');

    const open = (
      await db.query(`SELECT id FROM purchase_orders WHERE status = 'APPROVED' LIMIT 1`)
    ).rows[0];
    if (open) {
      await db.query('BEGIN');
      await expect(
        db.query(`UPDATE purchase_orders SET status = 'RECEIVED' WHERE id = $1`, [open.id]),
      ).rejects.toMatchObject({ code: '23514', constraint: 'po_status_matches_timestamps' });
      await db.query('ROLLBACK');
    }
  });
});

// ------------------------------------------------------------------ whole-system checks

describe('after all of the above', () => {
  it('stock still equals the ledger, and every PO / transfer from a recommendation is linked once', async () => {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS mismatches
         FROM inventory_balances b
         LEFT JOIN (SELECT product_id, location_id, SUM(on_hand_delta) AS oh, SUM(reserved_delta) AS r
                      FROM inventory_ledger GROUP BY 1, 2) s USING (product_id, location_id)
        WHERE b.on_hand <> COALESCE(s.oh, 0) OR b.reserved <> COALESCE(s.r, 0)`,
    );
    expect(rows[0].mismatches).toBe(0);

    const orphans = await db.query(
      `SELECT (SELECT COUNT(*)::int FROM purchase_orders po
                WHERE po.notes LIKE 'Replenishment recommendation %'
                  AND NOT EXISTS (SELECT 1 FROM replenishment_recommendations r WHERE r.purchase_order_id = po.id))
            + (SELECT COUNT(*)::int FROM stock_transfers t
                WHERE t.notes LIKE 'Replenishment recommendation %'
                  AND NOT EXISTS (SELECT 1 FROM replenishment_recommendations r WHERE r.transfer_id = t.id)) AS orphans`,
    );
    expect(orphans.rows[0].orphans).toBe(0);
  });

  it('every event is still delivered exactly once (no recommendation work leaves events stuck)', async () => {
    const stuck = await db.query(
      `SELECT COUNT(*)::int AS n FROM outbox_events WHERE status = 'DEAD'`,
    );
    expect(stuck.rows[0].n).toBe(0);
  });
});
