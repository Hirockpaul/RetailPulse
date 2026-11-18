/**
 * V2 step 2a: ABC/XYZ classification against a real PostgreSQL, with sales histories written into
 * forecast.demand_daily (as the forecasting service does) so every class can be checked by hand.
 */
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
let P: { id: string; sku: string }[];

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
  const locations = (await as('admin').get('/locations?pageSize=100').expect(200)).body.data;
  const idOf = (code: string) => locations.find((l: { code: string }) => l.code === code).id;
  str1 = idOf('STR-01');
  str2 = idOf('STR-02');
  P = (await as('admin').get('/products?sort=sku:asc&pageSize=4').expect(200)).body.data;
}, 60_000);

afterAll(async () => {
  await db?.end();
  await app?.close();
  await releaseTestDatabase();
});

/** Daily sales for `days` days ending yesterday; `units(d)` gets the day index (0 = oldest). */
async function history(
  productId: string,
  locationId: string,
  days: number,
  units: (d: number) => number,
) {
  const values = Array.from({ length: days }, (_, d) => units(d));
  await db.query(
    `INSERT INTO forecast.demand_daily (product_id, location_id, day, units, source)
     SELECT $1, $2, current_date - 1 - $3::int + g::int, u, 'SYNTHETIC'
       FROM unnest($4::int[]) WITH ORDINALITY AS t(u, g)`,
    [productId, locationId, days, values],
  );
}

const cost = async (productId: string) =>
  Number(
    (
      await db.query(
        'SELECT unit_cost FROM supplier_products WHERE product_id = $1 AND is_primary',
        [productId],
      )
    ).rows[0].unit_cost,
  );

describe('ABC/XYZ classification', () => {
  it('needs sales history, and only admins / inventory managers may recalculate', async () => {
    const res = await as('inventory').post('/classifications/recalculate').expect(409);
    expect(res.body.error.code).toBe('NO_SALES_HISTORY');
    await as('analyst').post('/classifications/recalculate').expect(403);
    await as('store1').post('/classifications/recalculate').expect(403);
    const empty = (await as('analyst').get('/classifications/summary').expect(200)).body;
    expect(empty).toMatchObject({ run: null, cells: [] });
  });

  it('classifies by value and by weekly predictability, with the numbers behind it', async () => {
    // P0: 20 a day at both stores, steady. P1: 1 a day, steady. P2: 70 every 7th week only.
    // P3: only 30 days old → NEW.
    for (const loc of [str1, str2]) await history(P[0].id, loc, 364, () => 20);
    await history(P[1].id, str1, 364, () => 1);
    await history(P[2].id, str1, 364, (d) => (Math.floor(d / 7) % 7 === 0 ? 70 : 0));
    await history(P[3].id, str1, 30, () => 50);

    const summary = (await as('inventory').post('/classifications/recalculate').expect(200)).body;
    expect(summary.run).toMatchObject({ dataLabel: 'SYNTHETIC', itemCount: expect.any(Number) });
    expect(summary.rules).toMatchObject({
      windowWeeks: 52,
      minWeeks: 13,
      abc: { a: 0.8, b: 0.95 },
    });
    expect(summary.policies.AX).toMatch(/steady/);

    const network = (await as('analyst').get('/classifications?pageSize=10').expect(200)).body.data;
    const byId = Object.fromEntries(network.map((r: { productId: string }) => [r.productId, r]));
    const c0 = await cost(P[0].id);
    expect(byId[P[0].id]).toMatchObject({
      xyz: 'X',
      units: 2 * 364 * 20,
      weeksObserved: 52,
      cv: 0,
      adi: 1,
    });
    expect(byId[P[0].id].value).toBeCloseTo(2 * 364 * 20 * c0, 0);
    expect(byId[P[1].id]).toMatchObject({ xyz: 'X', units: 364 });
    expect(byId[P[2].id]).toMatchObject({ xyz: 'Z' }); // sells one week in seven: intermittent
    expect(byId[P[2].id].adi).toBeCloseTo(52 / 8, 5); // sold in 8 of 52 weeks
    expect(byId[P[3].id]).toMatchObject({ cls: 'NEW', abc: null, xyz: null });
    // ABC: value shares add up to 1 over the classified products, ordered by value.
    const judged = network.filter((r: { cls: string }) => r.cls !== 'NEW');
    expect(
      judged.reduce((s: number, r: { valueShare: number }) => s + r.valueShare, 0),
    ).toBeCloseTo(1, 5);
    expect(judged[0].abc).toBe('A');
    expect(judged.at(-1).cumulativeShare).toBeCloseTo(1, 5);
  });

  it('per store: only that store’s sales, store-scoped for store managers', async () => {
    const store1 = (await as('store1').get(`/classifications?locationId=${str1}`).expect(200)).body;
    expect(store1.data.map((r: { productId: string }) => r.productId).sort()).toEqual(
      P.map((p) => p.id).sort(),
    );
    const s2 = (await as('admin').get(`/classifications?locationId=${str2}`).expect(200)).body.data;
    expect(s2).toHaveLength(1); // only P0 ever sold at STR-02
    expect(s2[0]).toMatchObject({ productId: P[0].id, cls: 'AX', valueShare: 1 });
    await as('store1').get(`/classifications?locationId=${str2}`).expect(403);
    await as('store1').get(`/classifications/summary?locationId=${str2}`).expect(403);
    const summary = (
      await as('store1').get(`/classifications/summary?locationId=${str1}`).expect(200)
    ).body;
    expect(summary.scope).toEqual({ locationId: str1, locationCode: 'STR-01' });
    expect(summary.cells.reduce((n: number, c: { count: number }) => n + c.count, 0)).toBe(4);
  });

  it('filters by class and search, validates input, and changes no stock', async () => {
    const before = Number((await db.query('SELECT COUNT(*) AS n FROM inventory_ledger')).rows[0].n);
    const news = (await as('admin').get('/classifications?cls=NEW').expect(200)).body.data;
    expect(news.map((r: { productId: string }) => r.productId)).toEqual([P[3].id]);
    const found = (await as('admin').get(`/classifications?q=${P[1].sku}`).expect(200)).body.data;
    expect(found).toHaveLength(1);
    await as('admin').get('/classifications?cls=QQ').expect(400);
    await as('admin').get('/classifications?sort=price:asc').expect(400);
    await as('admin').get('/classifications?locationId=nope').expect(400);
    await as('inventory').post('/classifications/recalculate').expect(200);
    expect(Number((await db.query('SELECT COUNT(*) AS n FROM inventory_ledger')).rows[0].n)).toBe(
      before,
    );
  });

  it('keeps the newest 5 runs; every row matches its class rule in the database', async () => {
    for (let i = 0; i < 5; i++) await as('admin').post('/classifications/recalculate').expect(200);
    expect(
      Number((await db.query('SELECT COUNT(*) AS n FROM classification_runs')).rows[0].n),
    ).toBe(5);
    await expect(
      db.query(`UPDATE inventory_classifications SET cls = 'AX', abc = 'C' WHERE cls <> 'NEW'`),
    ).rejects.toThrow(/classification_class_matches/);
  });
});
