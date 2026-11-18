/**
 * V2 4c-1: reports against a real PostgreSQL. Ledger rows are inserted at chosen times (the
 * ledger trigger keeps balances consistent) so every total — including the UTC day boundary —
 * can be checked by hand.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { loadEnv } from '../../src/core/config/env';
import { ReportsService } from '../../src/modules/reports/reports.service';
import { DEMO, login } from './auth-helpers';
import { prepareTestDatabase, releaseTestDatabase } from './test-db';

let url: string;
let app: INestApplication;
let db: pg.Client;
const cookies = {} as Record<keyof typeof DEMO, string>;
let str1: string;
let str2: string;
let product: { id: string; sku: string; price: number };
let day: string; // the hand-built day: three days ago (UTC), with no other ledger activity
let yesterday: string;

const http = () => request(app.getHttpServer());
const as = (who: keyof typeof DEMO) => ({
  get: (path: string) => http().get(`/api/v1${path}`).set('Cookie', cookies[who]),
  post: (path: string, body: object = {}) =>
    http().post(`/api/v1${path}`).set('Cookie', cookies[who]).send(body),
});

/** A ledger row at an exact UTC time. */
const ledger = (
  type: string,
  delta: number,
  at: string,
  location = str1,
  reason: string | null = null,
) =>
  db.query(
    `INSERT INTO inventory_ledger (product_id, location_id, movement_type, on_hand_delta, reason,
        occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz)`,
    [product.id, location, type, delta, reason, at],
  );

const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
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
  [str1, str2] = ['STR-01', 'STR-02'].map(idOf);
  const p = (
    await db.query(
      `SELECT p.id, p.sku::text AS sku, p.unit_price::float8 AS price FROM products p
        JOIN inventory_balances b ON b.product_id = p.id AND b.location_id = $1 AND b.on_hand >= 50
        ORDER BY p.sku LIMIT 1`,
      [str1],
    )
  ).rows[0];
  product = p;
  yesterday = (await db.query(`SELECT ((now() AT TIME ZONE 'UTC')::date - 1)::text AS d`)).rows[0]
    .d;
  day = addDays(yesterday, -2);
  // The hand-built day D (UTC):
  await ledger('SALE', -3, `${day}T00:00:00Z`); //            first instant of D: counts
  await ledger('SALE', -2, `${day}T23:59:59.999Z`); //      last instant of D: counts
  await ledger('SALE', -5, `${addDays(day, -1)}T23:59:59.999Z`); // the day before: weekly only
  await ledger('SALE', -4, `${addDays(day, 1)}T00:00:00Z`); // the day after: not in D
  await ledger('RETURN', 1, `${day}T10:00:00Z`);
  await ledger('RECEIPT', 10, `${day}T08:00:00Z`);
  await ledger('ADJUSTMENT', -2, `${day}T12:00:00Z`, str1, 'damaged');
  await ledger('ADJUSTMENT', 1, `${day}T13:00:00Z`, str1, 'found');
  await ledger('SALE', -7, `${day}T09:00:00Z`, str2); // another store
  await db.query(
    `INSERT INTO forecast.anomaly_detections (product_id, location_id, day, kind, severity, score,
        observed, expected, method, rule, explanation, detected_at)
     VALUES ($1, $2, $3::date, 'SPIKE', 'HIGH', 9, 30, 5, 'robust_z', 'test', 'test', $4::timestamptz)`,
    [product.id, str1, day, `${day}T15:00:00Z`],
  );
}, 60_000);

afterAll(async () => {
  await db?.end();
  await app?.close();
  await releaseTestDatabase();
});

type Report = {
  id: string;
  kind: string;
  periodStart: string;
  periodEnd: string;
  locationId: string | null;
  trigger: string;
  generatedBy: string | null;
  content: {
    scope: { code: string } | null;
    generatedAt: string;
    sales: {
      unitsSold: number;
      unitsReturned: number;
      salesValueAtPrice: number;
      byStore: { code: string; unitsSold: number }[];
      topProducts: { sku: string; unitsSold: number }[];
    };
    movements: Record<string, number>;
    work: Record<string, number>;
    stockAtGeneration: Record<string, number | string | null>;
  };
};

describe('reports (V2 4c-1)', () => {
  it('a daily store report has exact totals, including the UTC day boundary', async () => {
    const r = (
      await as('inventory')
        .post('/reports/generate', { kind: 'DAILY', locationId: str1, periodEnd: day })
        .expect(201)
    ).body as Report;
    expect(r).toMatchObject({
      kind: 'DAILY',
      periodStart: day,
      periodEnd: day,
      locationId: str1,
      trigger: 'MANUAL',
      generatedBy: 'Imani Inventory',
    });
    const s = r.content.sales;
    expect(s.unitsSold).toBe(5); // 3 at 00:00:00 + 2 at 23:59:59.999; not the day before/after
    expect(s.unitsReturned).toBe(1);
    expect(s.salesValueAtPrice).toBeCloseTo(5 * product.price, 2);
    expect(s.byStore).toEqual([
      { locationId: str1, code: 'STR-01', unitsSold: 5, valueAtPrice: expect.any(Number) },
    ]);
    expect(s.topProducts).toEqual([expect.objectContaining({ sku: product.sku, unitsSold: 5 })]);
    expect(r.content.movements).toEqual({
      receipts: 10,
      transfersIn: 0,
      transfersOut: 0,
      returns: 1,
      adjustmentsNet: -1,
      adjustmentsRemoved: 2,
    });
    expect(r.content.work.anomaliesFound).toBe(1);
    expect(r.content.scope).toMatchObject({ code: 'STR-01' });
    expect(r.content.stockAtGeneration.onHand).toEqual(expect.any(Number));
    expect(r.content.stockAtGeneration.atRisk7).toBeNull(); // no forecast in this database
  });

  it('a network report adds every store; a weekly report covers the seven days ending on its end', async () => {
    const net = (
      await as('admin').post('/reports/generate', { kind: 'DAILY', periodEnd: day }).expect(201)
    ).body as Report;
    expect(net.content.scope).toBeNull();
    expect(net.content.sales.unitsSold).toBe(12); // 5 at STR-01 + 7 at STR-02
    expect(net.content.sales.byStore.find((b) => b.code === 'STR-02')!.unitsSold).toBe(7);

    const week = (
      await as('admin')
        .post('/reports/generate', { kind: 'WEEKLY', locationId: str1, periodEnd: day })
        .expect(201)
    ).body as Report;
    expect(week).toMatchObject({ periodStart: addDays(day, -6), periodEnd: day });
    expect(week.content.sales.unitsSold).toBe(10); // + the 5 on the day before
  });

  it('a report is frozen: later movements do not change it', async () => {
    const r = (
      await as('admin')
        .post('/reports/generate', { kind: 'DAILY', locationId: str1, periodEnd: day })
        .expect(201)
    ).body as Report;
    await ledger('SALE', -1, `${day}T18:00:00Z`);
    const again = (await as('admin').get(`/reports/${r.id}`).expect(200)).body as Report;
    expect(again.content).toEqual(r.content);
    expect(again.content.sales.unitsSold).toBe(5);
    await expect(
      db.query(`UPDATE report_runs SET duration_ms = 0 WHERE id = $1`, [r.id]),
    ).rejects.toMatchObject({ code: '23001' });
  });

  it('periods must be complete, kinds and dates valid', async () => {
    const today = addDays(yesterday, 1);
    const res = await as('admin')
      .post('/reports/generate', { kind: 'DAILY', periodEnd: today })
      .expect(422);
    expect(res.body.error.code).toBe('PERIOD_NOT_COMPLETE');
    await as('admin').post('/reports/generate', { kind: 'MONTHLY' }).expect(400);
    await as('admin')
      .post('/reports/generate', { kind: 'DAILY', periodEnd: '17/11/2026' })
      .expect(400);
    const dflt = (await as('admin').post('/reports/generate', { kind: 'DAILY' }).expect(201)).body;
    expect(dflt.periodEnd).toBe(yesterday);
  });

  it('store managers: own store only — no other store, no network report', async () => {
    const own = (
      await as('store1')
        .post('/reports/generate', { kind: 'DAILY', locationId: str1, periodEnd: day })
        .expect(201)
    ).body as Report;
    await as('store1').post('/reports/generate', { kind: 'DAILY', locationId: str2 }).expect(403);
    await as('store1').post('/reports/generate', { kind: 'DAILY' }).expect(403);

    const network = (await as('analyst').post('/reports/generate', { kind: 'DAILY' }).expect(201))
      .body as Report;
    await as('store1').get(`/reports/${network.id}`).expect(403);
    await as('store1').get(`/reports/${network.id}/export.csv`).expect(403);
    await as('store2').get(`/reports/${own.id}`).expect(403);
    await as('store1').get(`/reports/${own.id}`).expect(200);

    const list = (await as('store1').get('/reports?pageSize=100').expect(200)).body;
    expect(list.data.every((r: Report) => r.locationId === str1)).toBe(true);
    expect(list.data.length).toBeGreaterThan(0);
    const all = (await as('analyst').get('/reports?pageSize=100').expect(200)).body;
    expect(all.total).toBeGreaterThan(list.total);
    await as('store1').get(`/reports?locationId=${str2}`).expect(403);
    await http().get('/api/v1/reports').expect(401);
  });

  it('exports CSV: header, one row per number, file name with kind, scope and period', async () => {
    const r = (
      await as('admin')
        .post('/reports/generate', { kind: 'DAILY', locationId: str1, periodEnd: day })
        .expect(201)
    ).body as Report;
    const res = await as('admin').get(`/reports/${r.id}/export.csv`).expect(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="retailpulse-daily-STR-01-${day}.csv"`,
    );
    const lines = res.text.split('\r\n');
    expect(lines[0]).toBe('section,metric,location,product,value');
    // 6, not 5: the "frozen" test above added one later sale on that day (new report, new snapshot).
    expect(r.content.sales.unitsSold).toBe(6);
    expect(lines).toContain('sales,units_sold,STR-01,,6');
    expect(lines).toContain(`report,period_end,STR-01,,${day}`);
    expect(lines).toContain('movements,adjustments_removed,STR-01,,2');
  });

  it('the schedule creates yesterday (and on Mondays last week) once, however often it runs', async () => {
    const service = app.get(ReportsService);
    const before = Number(
      (await db.query(`SELECT count(*) FROM report_runs WHERE trigger = 'SCHEDULED'`)).rows[0]
        .count,
    );
    const first = await service.runSchedule();
    const second = await service.runSchedule();
    const isMonday = new Date(`${addDays(yesterday, 1)}T00:00:00Z`).getUTCDay() === 1;
    expect(first).toBe(isMonday ? 2 : 1);
    expect(second).toBe(0);
    const rows = (
      await db.query(
        `SELECT kind, period_start::text AS s, period_end::text AS e, location_id, generated_by
           FROM report_runs WHERE trigger = 'SCHEDULED' ORDER BY kind`,
      )
    ).rows;
    expect(rows.length).toBe(before + first);
    expect(rows[0]).toMatchObject({
      kind: 'DAILY',
      s: yesterday,
      e: yesterday,
      location_id: null,
      generated_by: null,
    });
    // Two concurrent runs (two API instances) still create one each.
    await db.query(`DELETE FROM report_runs WHERE trigger = 'SCHEDULED'`);
    await Promise.all([service.runSchedule(), service.runSchedule()]);
    expect(
      Number(
        (await db.query(`SELECT count(*) FROM report_runs WHERE trigger = 'SCHEDULED'`)).rows[0]
          .count,
      ),
    ).toBe(isMonday ? 2 : 1);
  });

  it('generating writes nothing but the report', async () => {
    const snapshot = async () =>
      (
        await db.query(
          `SELECT (SELECT count(*) FROM inventory_ledger)::int AS ledger,
                  (SELECT md5(string_agg(product_id || ':' || location_id || ':' || on_hand || ':' || reserved,
                          ',' ORDER BY product_id, location_id)) FROM inventory_balances) AS balances,
                  (SELECT count(*) FROM outbox_events)::int AS outbox,
                  (SELECT count(*) FROM stock_transfers)::int AS transfers,
                  (SELECT count(*) FROM purchase_orders)::int AS orders,
                  (SELECT count(*) FROM replenishment_recommendations)::int AS recs,
                  (SELECT count(*) FROM alerts)::int AS alerts`,
        )
      ).rows[0];
    const before = await snapshot();
    const reports = Number((await db.query('SELECT count(*) FROM report_runs')).rows[0].count);
    await as('admin').post('/reports/generate', { kind: 'WEEKLY' }).expect(201);
    await as('admin').post('/reports/generate', { kind: 'DAILY', locationId: str2 }).expect(201);
    expect(await snapshot()).toEqual(before);
    expect(Number((await db.query('SELECT count(*) FROM report_runs')).rows[0].count)).toBe(
      reports + 2,
    );
  });
});
