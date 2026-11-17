/**
 * Role and store-level authorization, enforced on the server, against a real database.
 *   ADMIN / INVENTORY_MANAGER: everything          ANALYST: read-only
 *   STORE_MANAGER: own stores only (STR-01 for store1, STR-02 for store2)
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
import { prepareTestDatabase } from './test-db';

let app: INestApplication;
let db: pg.Client;
const cookies = {} as Record<keyof typeof DEMO, string>;
const loc = {} as Record<'str1' | 'str2' | 'dc', string>;

const as = (who: keyof typeof DEMO) => ({
  get: (url: string) =>
    request(app.getHttpServer()).get(`/api/v1${url}`).set('Cookie', cookies[who]),
  post: (url: string, body: object = {}, key: string | null = randomUUID()) => {
    const req = request(app.getHttpServer()).post(`/api/v1${url}`).set('Cookie', cookies[who]);
    if (key !== null) req.set('Idempotency-Key', key);
    return req.send(body);
  },
});
const admin = () => as('admin');

beforeAll(async () => {
  const url = await prepareTestDatabase();
  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: url });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).compile();
  app = configureApp(moduleRef.createNestApplication({ logger: false }));
  await app.init();
  db = new pg.Client({ connectionString: url });
  await db.connect();

  for (const who of Object.keys(DEMO) as (keyof typeof DEMO)[]) {
    cookies[who] = await login(app, DEMO[who]);
  }
  const locations = (await admin().get('/locations?pageSize=100').expect(200)).body.data;
  const idOf = (code: string) => locations.find((l: { code: string }) => l.code === code).id;
  loc.str1 = idOf('STR-01');
  loc.str2 = idOf('STR-02');
  loc.dc = idOf('DC-NORTH');
}, 60_000);

afterAll(async () => {
  await db?.end();
  await app?.close();
});

async function productId(sku: string): Promise<string> {
  const res = await admin().get(`/products?q=${sku}`).expect(200);
  return res.body.data.find((p: { sku: string }) => p.sku === sku).id;
}

/** Give a location a known amount of stock, as admin. */
async function setOnHand(product: string, location: string, target: number) {
  const stock = (await admin().get(`/products/${product}/stock`).expect(200)).body.data;
  const current = stock.find((r: { locationId: string }) => r.locationId === location)?.onHand ?? 0;
  if (current !== target) {
    await admin()
      .post('/adjustments', {
        productId: product,
        locationId: location,
        delta: target - current,
        reason: 'test setup',
      })
      .expect(201);
  }
}

const sale = (product: string, location: string) => ({
  locationId: location,
  lines: [{ productId: product, quantity: 1 }],
});

describe('analyst: read-only', () => {
  it('can read the catalog, stock anywhere, ledgers and transfers', async () => {
    const analyst = as('analyst');
    await analyst.get('/products').expect(200);
    await analyst.get('/categories').expect(200);
    await analyst.get(`/locations/${loc.str2}/stock`).expect(200);
    await analyst.get('/transfers').expect(200);
    await analyst.get('/reservations').expect(200);
    const locations = (await analyst.get('/locations').expect(200)).body.data;
    expect(locations.every((l: { totalOnHand: number | null }) => l.totalOnHand !== null)).toBe(
      true,
    );
  });

  it('cannot change anything', async () => {
    const analyst = as('analyst');
    const p = await productId('RP-00100');
    await setOnHand(p, loc.str1, 10);
    for (const [url, body] of [
      ['/sales', sale(p, loc.str1)],
      ['/receipts', { locationId: loc.str1, lines: [{ productId: p, quantity: 1 }] }],
      ['/returns', { locationId: loc.str1, productId: p, quantity: 1, condition: 'SELLABLE' }],
      ['/adjustments', { locationId: loc.str1, productId: p, delta: 1, reason: 'nope' }],
      ['/reservations', { locationId: loc.str1, productId: p, quantity: 1 }],
      [
        '/transfers',
        {
          sourceLocationId: loc.dc,
          destinationLocationId: loc.str1,
          lines: [{ productId: p, quantity: 1 }],
        },
      ],
    ] as [string, object][]) {
      const res = await analyst.post(url, body).expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
    const stock = (await admin().get(`/products/${p}/stock`).expect(200)).body.data;
    expect(stock.find((r: { locationId: string }) => r.locationId === loc.str1).onHand).toBe(10);
  });
});

describe('store manager: own stores only', () => {
  const store1 = () => as('store1');
  let product: string;

  beforeAll(async () => {
    product = await productId('RP-00110');
    await setOnHand(product, loc.str1, 20);
    await setOnHand(product, loc.str2, 20);
    await setOnHand(product, loc.dc, 200);
  });

  it('sees stock aggregates only for their own store in the location directory', async () => {
    const locations = (await store1().get('/locations?pageSize=100').expect(200)).body.data;
    const byId = new Map<string, { totalOnHand: number | null; skuCount: number | null }>(
      locations.map((l: { id: string }) => [l.id, l]),
    );
    expect(byId.size).toBe(7); // the directory itself is visible (needed to request transfers)
    expect(byId.get(loc.str1)!.totalOnHand).toEqual(expect.any(Number));
    expect(byId.get(loc.str2)!.totalOnHand).toBeNull();
    expect(byId.get(loc.str2)!.skuCount).toBeNull();
    expect(byId.get(loc.dc)!.totalOnHand).toBeNull();
  });

  it('can read their own store’s stock but gets 403 for other locations', async () => {
    await store1().get(`/locations/${loc.str1}/stock`).expect(200);
    for (const other of [loc.str2, loc.dc]) {
      const res = await store1().get(`/locations/${other}/stock`).expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('only receives their own store’s rows in per-product stock and ledger', async () => {
    const stock = (await store1().get(`/products/${product}/stock`).expect(200)).body.data;
    expect(stock.map((r: { locationId: string }) => r.locationId)).toEqual([loc.str1]);

    const ledger = (await store1().get(`/products/${product}/ledger?pageSize=100`).expect(200))
      .body;
    expect(ledger.total).toBeGreaterThan(0);
    expect(new Set(ledger.data.map((e: { locationCode: string }) => e.locationCode))).toEqual(
      new Set(['STR-01']),
    );
    await store1().get(`/products/${product}/ledger?locationId=${loc.str2}`).expect(403);

    const admin = await as('admin').get(`/products/${product}/ledger?pageSize=100`).expect(200);
    expect(admin.body.total).toBeGreaterThan(ledger.total); // admins see the whole network
  });

  it('can still read the catalog, including network-wide totals', async () => {
    const res = await store1().get('/products?q=RP-00110').expect(200);
    expect(res.body.data[0].totalOnHand).toBeGreaterThan(20);
  });

  it('can sell, receive, return, adjust and reserve in their own store', async () => {
    await store1().post('/sales', sale(product, loc.str1)).expect(201);
    await store1()
      .post('/receipts', { locationId: loc.str1, lines: [{ productId: product, quantity: 2 }] })
      .expect(201);
    await store1()
      .post('/returns', {
        locationId: loc.str1,
        productId: product,
        quantity: 1,
        condition: 'SELLABLE',
      })
      .expect(201);
    await store1()
      .post('/adjustments', {
        locationId: loc.str1,
        productId: product,
        delta: -1,
        reason: 'cycle count',
      })
      .expect(201);
    const r = await store1()
      .post('/reservations', { locationId: loc.str1, productId: product, quantity: 2 })
      .expect(201);
    await store1().post(`/reservations/${r.body.id}/release`, {}, null).expect(201);
  });

  it('records WHO made each stock movement in the ledger', async () => {
    const { rows } = await db.query(
      `SELECT e.movement_type, u.email
         FROM inventory_ledger e JOIN users u ON u.id = e.actor_id
        WHERE e.product_id = $1 AND e.location_id = $2 AND u.email = $3
        ORDER BY e.id`,
      [product, loc.str1, DEMO.store1],
    );
    expect(rows.map((r) => r.movement_type)).toEqual(
      expect.arrayContaining(['SALE', 'RECEIPT', 'RETURN', 'ADJUSTMENT', 'RESERVATION']),
    );
  });

  it('gets 403 for every write in another store or at a distribution centre', async () => {
    const forbidden = [
      ['/sales', sale(product, loc.str2)],
      ['/receipts', { locationId: loc.dc, lines: [{ productId: product, quantity: 1 }] }],
      ['/receipts', { locationId: loc.str2, lines: [{ productId: product, quantity: 1 }] }],
      [
        '/returns',
        { locationId: loc.str2, productId: product, quantity: 1, condition: 'SELLABLE' },
      ],
      ['/adjustments', { locationId: loc.str2, productId: product, delta: 1, reason: 'sneaky' }],
      ['/reservations', { locationId: loc.str2, productId: product, quantity: 1 }],
    ] as [string, object][];
    for (const [url, body] of forbidden) {
      const res = await store1().post(url, body).expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
    const stock2 = (await admin().get(`/products/${product}/stock`).expect(200)).body.data.find(
      (r: { locationId: string }) => r.locationId === loc.str2,
    );
    expect(stock2.onHand).toBe(20); // nothing leaked through
  });

  it('cannot see or release other stores’ sales and reservations', async () => {
    const orderAtStore2 = (await as('store2').post('/sales', sale(product, loc.str2)).expect(201))
      .body.id;
    await store1().get(`/sales/${orderAtStore2}`).expect(403);
    await as('store2').get(`/sales/${orderAtStore2}`).expect(200);
    await as('inventory').get(`/sales/${orderAtStore2}`).expect(200);

    const reservation = (
      await as('store2')
        .post('/reservations', { locationId: loc.str2, productId: product, quantity: 3 })
        .expect(201)
    ).body.id;
    const visible = await store1().get(`/reservations?productId=${product}`).expect(200);
    expect(visible.body.data.map((r: { id: string }) => r.id)).not.toContain(reservation);
    await store1().get(`/reservations/${reservation}`).expect(403);
    await store1().post(`/reservations/${reservation}/release`, {}, null).expect(403);
    await store1().get(`/reservations?locationId=${loc.str2}`).expect(403);
    await as('store2').post(`/reservations/${reservation}/release`, {}, null).expect(201);
  });

  it('cannot approve transfers (role) — that is for admins and inventory managers', async () => {
    const p = await productId('RP-00111');
    const t = await store1()
      .post('/transfers', {
        sourceLocationId: loc.dc,
        destinationLocationId: loc.str1,
        lines: [{ productId: p, quantity: 1 }],
      })
      .expect(201);
    const res = await store1().post(`/transfers/${t.body.id}/approve`, {}, null).expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

describe('inventory manager and admin: whole network', () => {
  it.each(['inventory', 'admin'] as const)(
    '%s can act in any store and read all stock',
    async (who) => {
      const p = await productId('RP-00120');
      await setOnHand(p, loc.str2, 15);
      await as(who).post('/sales', sale(p, loc.str2)).expect(201);
      await as(who)
        .post('/receipts', { locationId: loc.dc, lines: [{ productId: p, quantity: 5 }] })
        .expect(201);
      const stock = (await as(who).get(`/products/${p}/stock`).expect(200)).body.data;
      expect(stock).toHaveLength(7);
      await as(who).get(`/locations/${loc.str1}/stock`).expect(200);
    },
  );
});

describe('whole-system invariant', () => {
  it('every balance still equals the sum of its ledger rows', async () => {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS mismatches
         FROM inventory_balances b
         LEFT JOIN (SELECT product_id, location_id,
                           SUM(on_hand_delta) AS oh, SUM(reserved_delta) AS r
                      FROM inventory_ledger GROUP BY 1, 2) s USING (product_id, location_id)
        WHERE b.on_hand <> COALESCE(s.oh, 0) OR b.reserved <> COALESCE(s.r, 0)`,
    );
    expect(rows[0].mismatches).toBe(0);
  });
});
