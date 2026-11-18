/**
 * V2 step 2c: supplier performance from deliveries — seeded synthetic history plus deliveries of
 * real purchase orders — against a real PostgreSQL.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
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

const as = (who: keyof typeof DEMO) => ({
  get: (path: string) =>
    request(app.getHttpServer()).get(`/api/v1${path}`).set('Cookie', cookies[who]),
  post: (path: string) =>
    request(app.getHttpServer()).post(`/api/v1${path}`).set('Cookie', cookies[who]).send({}),
});

beforeAll(async () => {
  url = await prepareTestDatabase();
  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: url });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).compile();
  app = configureApp(moduleRef.createNestApplication({ logger: false }));
  await app.init();
  db = new pg.Client({ connectionString: url });
  await db.connect();
  for (const who of Object.keys(DEMO) as (keyof typeof DEMO)[])
    cookies[who] = await login(app, DEMO[who]);
}, 60_000);

afterAll(async () => {
  await db?.end();
  await app?.close();
  await releaseTestDatabase();
});

const n = async (sql: string, params: unknown[] = []) =>
  Number((await db.query(sql, params)).rows[0].n);

/** The supplier profiles the seed generates from (scripts/seed.mjs, docs/V2-PLAN.md 2c). */
const PROFILE_ON_TIME: Record<string, number> = {
  'SUP-GREEN': 0.9,
  'SUP-HARBOR': 0.75,
  'SUP-SUMMIT': 0.5,
};

describe('supplier performance', () => {
  it('recovers each supplier’s profile from the synthetic history (the pre-registered check)', async () => {
    const list = (await as('analyst').get('/suppliers/performance').expect(200)).body;
    expect(list).toHaveLength(3);
    for (const s of list) {
      expect(s.enoughData).toBe(true);
      expect(s.deliveries).toBe(s.synthetic); // nothing but history so far
      expect(Math.abs(s.onTimeRate - PROFILE_ON_TIME[s.code])).toBeLessThanOrEqual(0.1);
      expect(s.score).toBeGreaterThan(0);
      expect(s.score).toBeLessThanOrEqual(100);
    }
    const byCode = Object.fromEntries(list.map((s: { code: string }) => [s.code, s]));
    expect(byCode['SUP-GREEN'].onTimeRate).toBeGreaterThan(byCode['SUP-HARBOR'].onTimeRate);
    expect(byCode['SUP-HARBOR'].onTimeRate).toBeGreaterThan(byCode['SUP-SUMMIT'].onTimeRate);
    expect(byCode['SUP-GREEN'].score).toBeGreaterThan(byCode['SUP-SUMMIT'].score);
    expect(byCode['SUP-SUMMIT'].fillRate).toBeLessThan(1); // it ships short sometimes
  });

  it('shows one supplier per product, with recent deliveries limited to the caller’s stores', async () => {
    const list = (await as('admin').get('/suppliers/performance').expect(200)).body;
    const id = list.find((s: { code: string }) => s.code === 'SUP-SUMMIT').id;
    const detail = (await as('admin').get(`/suppliers/${id}/performance`).expect(200)).body;
    expect(detail.productStats.length).toBe(detail.products);
    expect(detail.productStats[0]).toMatchObject({
      sku: expect.any(String),
      deliveries: expect.any(Number),
    });
    expect(detail.rules.score).toMatch(/50 × on-time/);
    expect(detail.recent.length).toBe(20);
    const mine = (await as('store1').get(`/suppliers/${id}/performance`).expect(200)).body.recent;
    expect(mine.every((d: { locationCode: string }) => d.locationCode === 'STR-01')).toBe(true);
    await as('admin').get('/suppliers/not-a-uuid/performance').expect(400);
    await as('admin')
      .get('/suppliers/00000000-0000-4000-8000-000000000000/performance')
      .expect(404);
  });

  it('receiving a real purchase order adds one ORDER delivery per line, once', async () => {
    const { rows } = await db.query(
      `SELECT sp.supplier_id, sp.product_id, sp.unit_cost, l.id AS location_id,
              (SELECT id FROM users WHERE email = 'admin@retailpulse.test') AS user_id
         FROM supplier_products sp, locations l
        WHERE sp.is_primary AND l.code = 'STR-01' ORDER BY sp.product_id LIMIT 1`,
    );
    const r = rows[0];
    const po = await db.query(
      `INSERT INTO purchase_orders (supplier_id, destination_location_id, expected_date, created_by)
       VALUES ($1, $2, current_date + 4, $3) RETURNING id`,
      [r.supplier_id, r.location_id, r.user_id],
    );
    const poId = po.rows[0].id;
    await db.query(
      `INSERT INTO purchase_order_lines (purchase_order_id, product_id, quantity, unit_cost)
       VALUES ($1, $2, 24, $3)`,
      [poId, r.product_id, r.unit_cost],
    );
    await as('inventory').post(`/purchase-orders/${poId}/receive`).expect(201);
    const d = await db.query(
      `SELECT source, promised_days, (received_on - ordered_on) AS lead, ordered_qty, received_qty
         FROM supplier_deliveries WHERE purchase_order_id = $1`,
      [poId],
    );
    expect(d.rows).toEqual([
      { source: 'ORDER', promised_days: 4, lead: 0, ordered_qty: 24, received_qty: 24 },
    ]);
    await as('inventory').post(`/purchase-orders/${poId}/receive`).expect(409);
    expect(
      await n('SELECT COUNT(*) AS n FROM supplier_deliveries WHERE purchase_order_id = $1', [poId]),
    ).toBe(1);
    const list = (await as('admin').get('/suppliers/performance').expect(200)).body;
    const s = list.find((x: { id: string }) => x.id === r.supplier_id);
    expect(s.deliveries).toBe(s.synthetic + 1);
  });

  it('deliveries are facts: the database refuses edits; re-seeding adds no duplicates', async () => {
    await expect(db.query('UPDATE supplier_deliveries SET received_qty = 0')).rejects.toThrow(
      /facts and cannot be changed/,
    );
    const before = await n(
      `SELECT COUNT(*) AS n FROM supplier_deliveries WHERE source = 'SYNTHETIC'`,
    );
    execFileSync(process.execPath, [resolve(__dirname, '../../scripts/seed.mjs')], {
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'pipe',
    });
    expect(
      await n(`SELECT COUNT(*) AS n FROM supplier_deliveries WHERE source = 'SYNTHETIC'`),
    ).toBe(before);
    expect(await n('SELECT COUNT(*) AS n FROM purchase_orders')).toBe(1); // history created none
  });
});
