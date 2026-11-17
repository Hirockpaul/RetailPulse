/** Day 2 read endpoints against a real, freshly seeded test database. */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { loadEnv } from '../../src/core/config/env';
import { prepareTestDatabase } from './test-db';

const MISSING_ID = '00000000-0000-4000-8000-000000000000';
let app: INestApplication;
const get = (url: string) => request(app.getHttpServer()).get(`/api/v1${url}`);

beforeAll(async () => {
  const url = await prepareTestDatabase();
  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: url });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).compile();
  app = configureApp(moduleRef.createNestApplication({ logger: false }));
  await app.init();
}, 60_000);

afterAll(async () => app?.close());

function expectNotFound(res: request.Response) {
  expect(res.status).toBe(404);
  expect(res.body).toEqual({
    error: { code: 'NOT_FOUND', message: expect.any(String) },
    correlationId: expect.any(String),
  });
}

describe('GET /products', () => {
  it('paginates with defaults and reports the total', async () => {
    const res = await get('/products').expect(200);
    expect(res.body).toMatchObject({ page: 1, pageSize: 25, total: 200 });
    expect(res.body.data).toHaveLength(25);
    expect(res.body.data[0]).toEqual(
      expect.objectContaining({
        sku: 'RP-00001',
        unitPrice: expect.stringMatching(/^\d+\.\d{2}$/),
        totalOnHand: expect.any(Number),
        totalAvailable: expect.any(Number),
      }),
    );
  });

  it('returns an empty page past the end but keeps the total', async () => {
    const res = await get('/products?page=9&pageSize=25').expect(200);
    expect(res.body).toMatchObject({ data: [], total: 200 });
  });

  it('searches SKU and name case-insensitively', async () => {
    const res = await get('/products?q=rp-0000&pageSize=100').expect(200);
    expect(res.body.total).toBe(9); // RP-00001 … RP-00009
  });

  it('treats LIKE wildcards in search literally', async () => {
    const res = await get('/products?q=%25').expect(200); // "%"
    expect(res.body.total).toBe(0);
  });

  it('sorts by an allowed field', async () => {
    const res = await get('/products?sort=price:desc&pageSize=50').expect(200);
    const prices = res.body.data.map((p: { unitPrice: string }) => Number(p.unitPrice));
    expect(prices).toEqual([...prices].sort((a, b) => b - a));
  });

  it('filters by category', async () => {
    const { body: cats } = await get('/categories').expect(200);
    const dairy = cats.data.find((c: { name: string }) => c.name === 'Dairy');
    const res = await get(`/products?categoryId=${dairy.id}&pageSize=100`).expect(200);
    expect(res.body.total).toBe(dairy.productCount);
    expect(new Set(res.body.data.map((p: { categoryName: string }) => p.categoryName))).toEqual(
      new Set(['Dairy']),
    );
  });
});

describe('GET /categories', () => {
  it('lists categories with product counts', async () => {
    const res = await get('/categories').expect(200);
    expect(res.body.data).toHaveLength(8);
    const sum = res.body.data.reduce(
      (n: number, c: { productCount: number }) => n + c.productCount,
      0,
    );
    expect(sum).toBe(200);
  });
});

describe('GET /products/:id, /stock, /ledger', () => {
  let product: { id: string; totalOnHand: number; totalAvailable: number };

  beforeAll(async () => {
    const res = await get('/products?q=RP-00001').expect(200);
    product = res.body.data[0];
  });

  it('returns product detail with its primary supplier terms', async () => {
    const res = await get(`/products/${product.id}`).expect(200);
    expect(res.body.primarySupplier).toEqual({
      id: expect.any(String),
      code: expect.stringMatching(/^SUP-/),
      name: expect.stringContaining('(synthetic)'),
      leadTimeDays: expect.any(Number),
      minOrderQty: expect.any(Number),
      unitCost: expect.stringMatching(/^\d+\.\d{2}$/),
    });
  });

  it('returns stock per location that adds up to the product totals', async () => {
    const res = await get(`/products/${product.id}/stock`).expect(200);
    expect(res.body.asOf).toEqual(expect.any(String));
    expect(res.body.data).toHaveLength(7);
    const sum = (k: 'onHand' | 'available') =>
      res.body.data.reduce((n: number, r: Record<string, number>) => n + r[k], 0);
    expect(sum('onHand')).toBe(product.totalOnHand);
    expect(sum('available')).toBe(product.totalAvailable);
    for (const row of res.body.data) expect(row.available).toBe(row.onHand - row.reserved);
  });

  it('returns the ledger newest first, explaining every balance', async () => {
    const stock = await get(`/products/${product.id}/stock`).expect(200);
    const ledger = await get(`/products/${product.id}/ledger?pageSize=100`).expect(200);
    const nonZero = stock.body.data.filter((r: { onHand: number }) => r.onHand > 0).length;
    expect(ledger.body.total).toBe(nonZero);
    expect(ledger.body.data[0]).toMatchObject({
      movementType: 'RECEIPT',
      referenceType: 'SEED',
      onHandDelta: expect.any(Number),
      onHandAfter: expect.any(Number),
    });
    const ids = ledger.body.data.map((e: { id: string }) => Number(e.id));
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
  });

  it('filters the ledger by movement type', async () => {
    const res = await get(`/products/${product.id}/ledger?movementType=SALE`).expect(200);
    expect(res.body.total).toBe(0);
  });

  it.each(['', '/stock', '/ledger'])('404s for an unknown product (%s)', async (suffix) => {
    expectNotFound(await get(`/products/${MISSING_ID}${suffix}`));
  });
});

describe('GET /locations and /locations/:id/stock', () => {
  it('lists all locations and filters by type', async () => {
    const all = await get('/locations').expect(200);
    expect(all.body.total).toBe(7);
    const stores = await get('/locations?type=STORE').expect(200);
    expect(stores.body.total).toBe(5);
    expect(stores.body.data.every((l: { type: string }) => l.type === 'STORE')).toBe(true);
  });

  it('returns paginated stock for a location, sortable by availability', async () => {
    const { body } = await get('/locations?q=STR-01').expect(200);
    const store = body.data[0];
    const res = await get(`/locations/${store.id}/stock?sort=available:asc&pageSize=50`).expect(
      200,
    );
    expect(res.body).toMatchObject({ total: 200, location: { code: 'STR-01' } });
    expect(res.body.asOf).toEqual(expect.any(String));
    const avail = res.body.data.map((r: { available: number }) => r.available);
    expect(avail).toEqual([...avail].sort((a, b) => a - b));
    expect(avail[0]).toBe(0); // seed leaves ~10% of store SKUs empty
  });

  it('404s for an unknown location', async () => {
    expectNotFound(await get(`/locations/${MISSING_ID}`));
    expectNotFound(await get(`/locations/${MISSING_ID}/stock`));
  });
});
