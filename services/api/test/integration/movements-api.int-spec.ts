/**
 * Day 3 write paths against a real, freshly seeded database: sales, receipts, returns,
 * adjustments, reservations, idempotency, rollback and concurrency.
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
let storeId: string;
let dcId: string;
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

let cookie: string;
const api = () => request(app.getHttpServer());
const get = (url: string) => api().get(`/api/v1${url}`).set('Cookie', cookie);
const post = (url: string, body: object, key: string | null = randomUUID()) => {
  const req = api().post(`/api/v1${url}`).set('Cookie', cookie);
  if (key !== null) req.set('Idempotency-Key', key);
  return req.send(body);
};

beforeAll(async () => {
  const url = await prepareTestDatabase();
  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: url });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).compile();
  app = configureApp(moduleRef.createNestApplication({ logger: false }));
  await app.init();
  cookie = await login(app, DEMO.admin);
  db = new pg.Client({ connectionString: url });
  await db.connect();

  const locations = (await get('/locations?pageSize=100').expect(200)).body.data;
  storeId = locations.find((l: { code: string }) => l.code === 'STR-01').id;
  dcId = locations.find((l: { code: string }) => l.code === 'DC-NORTH').id;
}, 60_000);

afterAll(async () => {
  await db?.end();
  await app?.close();
});

// ------------------------------------------------------------------ helpers

async function productId(sku: string): Promise<string> {
  const res = await get(`/products?q=${sku}`).expect(200);
  return res.body.data.find((p: { sku: string }) => p.sku === sku).id;
}

async function stockOf(product: string, location: string) {
  const res = await get(`/products/${product}/stock`).expect(200);
  const row = res.body.data.find((r: { locationId: string }) => r.locationId === location);
  return {
    onHand: (row?.onHand ?? 0) as number,
    reserved: (row?.reserved ?? 0) as number,
    available: (row?.available ?? 0) as number,
  };
}

/** Bring on-hand to `target` using an adjustment (so the ledger stays truthful). */
async function setOnHand(product: string, location: string, target: number) {
  const { onHand } = await stockOf(product, location);
  if (onHand !== target) {
    await post('/adjustments', {
      productId: product,
      locationId: location,
      delta: target - onHand,
      reason: 'test setup',
    }).expect(201);
  }
}

async function ledgerTotal(product: string, query = ''): Promise<number> {
  return (await get(`/products/${product}/ledger?pageSize=1${query}`).expect(200)).body.total;
}

const count = async (table: string): Promise<number> =>
  (await db.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n;

const sale = (product: string, quantity: number, key?: string) =>
  post('/sales', { locationId: storeId, lines: [{ productId: product, quantity }] }, key);

// ------------------------------------------------------------------ sales

describe('POST /sales', () => {
  it('reduces available stock, snapshots prices, and writes traceable ledger rows', async () => {
    const [a, b] = await Promise.all([productId('RP-00010'), productId('RP-00011')]);
    await setOnHand(a, storeId, 20);
    await setOnHand(b, storeId, 20);
    const aDetail = (await get(`/products/${a}`).expect(200)).body;
    const bDetail = (await get(`/products/${b}`).expect(200)).body;

    const res = await post('/sales', {
      locationId: storeId,
      lines: [
        { productId: a, quantity: 3 },
        { productId: b, quantity: 2 },
      ],
    }).expect(201);

    const cents = (s: string) => Math.round(Number(s) * 100);
    expect(cents(res.body.totalAmount)).toBe(
      3 * cents(aDetail.unitPrice) + 2 * cents(bDetail.unitPrice),
    );
    expect(res.body.lines).toHaveLength(2);
    expect(res.body.lines.find((l: { productId: string }) => l.productId === a)).toMatchObject({
      quantity: 3,
      unitPrice: aDetail.unitPrice,
    });

    expect(await stockOf(a, storeId)).toEqual({ onHand: 17, reserved: 0, available: 17 });
    expect(await stockOf(b, storeId)).toEqual({ onHand: 18, reserved: 0, available: 18 });

    const ledger = (await get(`/products/${a}/ledger?movementType=SALE`).expect(200)).body.data[0];
    expect(ledger).toMatchObject({
      movementType: 'SALE',
      onHandDelta: -3,
      onHandAfter: 17,
      referenceType: 'SALES_ORDER',
      referenceId: res.body.id,
    });

    const fetched = await get(`/sales/${res.body.id}`).expect(200);
    expect(fetched.body).toEqual(res.body);
  });

  it('stores the correlation ID on the ledger row', async () => {
    const p = await productId('RP-00012');
    await setOnHand(p, storeId, 5);
    await api()
      .post('/api/v1/sales')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('x-correlation-id', 'corr-test-12345')
      .send({ locationId: storeId, lines: [{ productId: p, quantity: 1 }] })
      .expect(201);
    const { rows } = await db.query(
      `SELECT correlation_id FROM inventory_ledger WHERE product_id = $1 AND movement_type = 'SALE'
        ORDER BY id DESC LIMIT 1`,
      [p],
    );
    expect(rows[0].correlation_id).toBe('corr-test-12345');
  });

  it('409 INSUFFICIENT_STOCK when asking for more than is available', async () => {
    const p = await productId('RP-00013');
    await setOnHand(p, storeId, 4);
    const res = await sale(p, 5).expect(409);
    expect(res.body.error).toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      details: [{ productId: p, locationId: storeId }],
    });
    expect(res.body.correlationId).toEqual(expect.any(String));
    expect(await stockOf(p, storeId)).toMatchObject({ onHand: 4 });
  });

  it('cannot sell units that are reserved (available = on hand − reserved)', async () => {
    const p = await productId('RP-00014');
    await setOnHand(p, storeId, 10);
    const reservation = await post('/reservations', {
      productId: p,
      locationId: storeId,
      quantity: 8,
    }).expect(201);
    await sale(p, 3).expect(409);
    await sale(p, 2).expect(201); // exactly the 2 free units
    await post(`/reservations/${reservation.body.id}/release`, {}, null).expect(201);
  });

  it('rolls back the whole sale when any line fails (nothing written)', async () => {
    const [ok, empty] = await Promise.all([productId('RP-00015'), productId('RP-00016')]);
    await setOnHand(ok, storeId, 10);
    await setOnHand(empty, storeId, 0);
    const before = {
      orders: await count('sales_orders'),
      lines: await count('sales_order_lines'),
      ledger: await count('inventory_ledger'),
      keys: await count('idempotency_keys'),
    };

    const body = {
      locationId: storeId,
      lines: [
        { productId: ok, quantity: 2 },
        { productId: empty, quantity: 1 },
      ],
    };
    const key = randomUUID();
    await post('/sales', body, key).expect(409);

    expect(await stockOf(ok, storeId)).toMatchObject({ onHand: 10 });
    expect({
      orders: await count('sales_orders'),
      lines: await count('sales_order_lines'),
      ledger: await count('inventory_ledger'),
      keys: await count('idempotency_keys'),
    }).toEqual(before);

    // The failed request left no idempotency key, so the same key can be retried once fixed.
    await setOnHand(empty, storeId, 1);
    const retry = await post('/sales', body, key).expect(201);
    expect(retry.headers['idempotent-replayed']).toBeUndefined();
    expect(await stockOf(ok, storeId)).toMatchObject({ onHand: 8 });
  });

  it('rejects sales at distribution centres, unknown products and unknown locations', async () => {
    const p = await productId('RP-00017');
    const dc = await post('/sales', { locationId: dcId, lines: [{ productId: p, quantity: 1 }] });
    expect(dc.status).toBe(422);
    expect(dc.body.error.code).toBe('INVALID_LOCATION_TYPE');

    const unknownProduct = await sale(MISSING_ID, 1).expect(404);
    expect(unknownProduct.body.error.code).toBe('NOT_FOUND');

    await post('/sales', { locationId: MISSING_ID, lines: [{ productId: p, quantity: 1 }] }).expect(
      404,
    );
  });

  it('refuses inactive products', async () => {
    const p = await productId('RP-00018');
    await setOnHand(p, storeId, 5);
    await db.query('UPDATE products SET is_active = false WHERE id = $1', [p]);
    try {
      const res = await sale(p, 1).expect(409);
      expect(res.body.error.code).toBe('PRODUCT_INACTIVE');
    } finally {
      await db.query('UPDATE products SET is_active = true WHERE id = $1', [p]);
    }
  });

  it.each([
    ['empty lines', { lines: [] }],
    ['zero quantity', { lines: [{ productId: MISSING_ID, quantity: 0 }] }],
    ['fractional quantity', { lines: [{ productId: MISSING_ID, quantity: 1.5 }] }],
    [
      'duplicate product',
      {
        lines: [
          { productId: MISSING_ID, quantity: 1 },
          { productId: MISSING_ID, quantity: 1 },
        ],
      },
    ],
  ])('400 for %s', async (_name, partial) => {
    const res = await post('/sales', { locationId: storeId, ...partial }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('404s for an unknown sales order', async () => {
    await get(`/sales/${MISSING_ID}`).expect(404);
  });
});

// ------------------------------------------------------------ idempotency

describe('Idempotency-Key', () => {
  it('is required, and must be well formed', async () => {
    const p = await productId('RP-00020');
    const body = { locationId: storeId, lines: [{ productId: p, quantity: 1 }] };
    for (const key of [null, 'short', 'has spaces in it!']) {
      const res = await post('/sales', body, key).expect(400);
      expect(res.body.error.details[0].path).toBe('Idempotency-Key');
    }
  });

  it('a retry returns the same response and does not decrement stock twice', async () => {
    const p = await productId('RP-00021');
    await setOnHand(p, storeId, 10);
    const key = randomUUID();
    const ledgerBefore = await ledgerTotal(p);

    const first = await sale(p, 4, key).expect(201);
    const retry = await sale(p, 4, key).expect(201);

    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body).toEqual(first.body);
    expect(await stockOf(p, storeId)).toMatchObject({ onHand: 6 });
    expect(await ledgerTotal(p)).toBe(ledgerBefore + 1);
  });

  it('422 when the same key is reused for a different request', async () => {
    const p = await productId('RP-00022');
    await setOnHand(p, storeId, 10);
    const key = randomUUID();
    await sale(p, 1, key).expect(201);
    const res = await sale(p, 2, key).expect(422);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await stockOf(p, storeId)).toMatchObject({ onHand: 9 });
  });

  it('the same key on a different endpoint is a different request', async () => {
    const p = await productId('RP-00023');
    await setOnHand(p, storeId, 10);
    const key = randomUUID();
    await sale(p, 1, key).expect(201);
    await post(
      '/receipts',
      { locationId: storeId, lines: [{ productId: p, quantity: 1 }] },
      key,
    ).expect(201);
  });

  it('five simultaneous identical requests apply exactly once', async () => {
    const p = await productId('RP-00024');
    await setOnHand(p, storeId, 10);
    const key = randomUUID();
    const ledgerBefore = await ledgerTotal(p, '&movementType=SALE');

    const results = await Promise.all(Array.from({ length: 5 }, () => sale(p, 3, key)));

    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(results.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(4);
    expect(await stockOf(p, storeId)).toMatchObject({ onHand: 7 });
    expect(await ledgerTotal(p, '&movementType=SALE')).toBe(ledgerBefore + 1);
  });
});

// ------------------------------------------------------------ concurrency

describe('concurrency', () => {
  it('20 simultaneous sales of 1 unit against 10 available: exactly 10 succeed', async () => {
    const p = await productId('RP-00030');
    await setOnHand(p, storeId, 10);
    const salesBefore = await ledgerTotal(p, '&movementType=SALE');

    const results = await Promise.all(Array.from({ length: 20 }, () => sale(p, 1)));

    const ok = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status === 409);
    expect(ok).toHaveLength(10);
    expect(rejected).toHaveLength(10);
    expect(rejected.every((r) => r.body.error.code === 'INSUFFICIENT_STOCK')).toBe(true);
    expect(await stockOf(p, storeId)).toEqual({ onHand: 0, reserved: 0, available: 0 });
    expect(await ledgerTotal(p, '&movementType=SALE')).toBe(salesBefore + 10);
  });

  it('concurrent multi-line sales in opposite order do not deadlock', async () => {
    const [a, b] = await Promise.all([productId('RP-00031'), productId('RP-00032')]);
    await setOnHand(a, storeId, 30);
    await setOnHand(b, storeId, 30);
    const lines = (first: string, second: string) => [
      { productId: first, quantity: 1 },
      { productId: second, quantity: 1 },
    ];
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        post('/sales', { locationId: storeId, lines: i % 2 ? lines(a, b) : lines(b, a) }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(201));
    expect(await stockOf(a, storeId)).toMatchObject({ onHand: 20 });
    expect(await stockOf(b, storeId)).toMatchObject({ onHand: 20 });
  });
});

// ------------------------------------------------------ receipts, returns, adjustments

describe('POST /receipts', () => {
  it('increases on-hand at any location, with a document reference', async () => {
    const p = await productId('RP-00040');
    await setOnHand(p, dcId, 100);
    const res = await post('/receipts', {
      locationId: dcId,
      reference: 'DN-1001',
      lines: [{ productId: p, quantity: 25 }],
    }).expect(201);
    expect(res.body.data[0]).toMatchObject({
      movementType: 'RECEIPT',
      onHandDelta: 25,
      onHandAfter: 125,
    });
    expect(await stockOf(p, dcId)).toMatchObject({ onHand: 125 });
    const entry = (await get(`/products/${p}/ledger?movementType=RECEIPT`).expect(200)).body
      .data[0];
    expect(entry).toMatchObject({ referenceType: 'RECEIPT_REF', referenceId: 'DN-1001' });
  });

  it('creates the balance for a product first stocked at a location', async () => {
    const p = await productId('RP-00041');
    await db.query(
      `DELETE FROM inventory_balances WHERE product_id = $1 AND location_id = $2
         AND on_hand = 0 AND reserved = 0`,
      [p, storeId],
    );
    await setOnHand(p, storeId, 0);
    await post('/receipts', { locationId: storeId, lines: [{ productId: p, quantity: 7 }] }).expect(
      201,
    );
    expect(await stockOf(p, storeId)).toMatchObject({ onHand: 7 });
  });

  it('404s for an unknown product or location; 400 for duplicate lines', async () => {
    const p = await productId('RP-00042');
    const noProduct = await post('/receipts', {
      locationId: storeId,
      lines: [{ productId: MISSING_ID, quantity: 1 }],
    }).expect(404);
    expect(noProduct.body.error.message).toMatch(/product/i);
    const noLocation = await post('/receipts', {
      locationId: MISSING_ID,
      lines: [{ productId: p, quantity: 1 }],
    }).expect(404);
    expect(noLocation.body.error.message).toMatch(/location/i);
    await post('/receipts', {
      locationId: storeId,
      lines: [
        { productId: p, quantity: 1 },
        { productId: p, quantity: 2 },
      ],
    }).expect(400);
  });
});

describe('POST /returns', () => {
  it('a sellable return puts stock back on the shelf', async () => {
    const p = await productId('RP-00050');
    await setOnHand(p, storeId, 5);
    await post('/returns', {
      locationId: storeId,
      productId: p,
      quantity: 2,
      condition: 'SELLABLE',
    }).expect(201);
    expect(await stockOf(p, storeId)).toMatchObject({ onHand: 7 });
  });

  it('a damaged return is recorded in the ledger but not restocked', async () => {
    const p = await productId('RP-00051');
    await setOnHand(p, storeId, 5);
    await post('/returns', {
      locationId: storeId,
      productId: p,
      quantity: 3,
      condition: 'DAMAGED',
      reason: 'crushed box',
    }).expect(201);
    expect(await stockOf(p, storeId)).toMatchObject({ onHand: 5 });
    const entry = (await get(`/products/${p}/ledger?movementType=RETURN`).expect(200)).body.data[0];
    expect(entry).toMatchObject({ onHandDelta: 0 });
    expect(entry.reason).toMatch(/damaged return: 3 unit\(s\) not restocked.*crushed box/i);
  });
});

describe('POST /adjustments', () => {
  it('applies a signed correction with a mandatory reason', async () => {
    const p = await productId('RP-00060');
    await setOnHand(p, storeId, 10);
    await post('/adjustments', {
      productId: p,
      locationId: storeId,
      delta: -4,
      reason: 'cycle count',
    }).expect(201);
    expect(await stockOf(p, storeId)).toMatchObject({ onHand: 6 });
    const entry = (await get(`/products/${p}/ledger?movementType=ADJUSTMENT`).expect(200)).body
      .data[0];
    expect(entry).toMatchObject({ onHandDelta: -4, reason: 'cycle count' });
  });

  it('cannot drive stock below zero or below reserved', async () => {
    const p = await productId('RP-00061');
    await setOnHand(p, storeId, 3);
    const res = await post('/adjustments', {
      productId: p,
      locationId: storeId,
      delta: -4,
      reason: 'miscount',
    }).expect(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await stockOf(p, storeId)).toMatchObject({ onHand: 3 });
  });

  it.each([
    ['zero delta', { delta: 0, reason: 'nothing' }],
    ['missing reason', { delta: 1 }],
    ['blank reason', { delta: 1, reason: '   ' }],
    ['fractional delta', { delta: 1.5, reason: 'half a unit' }],
  ])('400 for %s', async (_name, partial) => {
    const p = await productId('RP-00062');
    const res = await post('/adjustments', {
      productId: p,
      locationId: storeId,
      ...partial,
    }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});

// ------------------------------------------------------------ reservations

describe('reservations', () => {
  it('reserve lowers available but not on-hand; release restores it', async () => {
    const p = await productId('RP-00070');
    await setOnHand(p, storeId, 10);

    const created = await post('/reservations', {
      productId: p,
      locationId: storeId,
      quantity: 4,
      reference: 'click-and-collect #1',
    }).expect(201);
    expect(created.body).toMatchObject({ status: 'ACTIVE', quantity: 4, releasedAt: null });
    expect(await stockOf(p, storeId)).toEqual({ onHand: 10, reserved: 4, available: 6 });

    const released = await post(`/reservations/${created.body.id}/release`, {}, null).expect(201);
    expect(released.body.status).toBe('RELEASED');
    expect(released.body.releasedAt).toEqual(expect.any(String));
    expect(await stockOf(p, storeId)).toEqual({ onHand: 10, reserved: 0, available: 10 });

    const kinds = (await get(`/products/${p}/ledger?pageSize=2`).expect(200)).body.data.map(
      (e: { movementType: string }) => e.movementType,
    );
    expect(kinds).toEqual(['RESERVATION_RELEASE', 'RESERVATION']);
  });

  it('a second release is 409 INVALID_STATE_TRANSITION and changes nothing', async () => {
    const p = await productId('RP-00071');
    await setOnHand(p, storeId, 10);
    const created = await post('/reservations', {
      productId: p,
      locationId: storeId,
      quantity: 3,
    }).expect(201);
    await post(`/reservations/${created.body.id}/release`, {}, null).expect(201);
    const again = await post(`/reservations/${created.body.id}/release`, {}, null).expect(409);
    expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(await stockOf(p, storeId)).toMatchObject({ reserved: 0 });
  });

  it('concurrent releases of one reservation succeed exactly once', async () => {
    const p = await productId('RP-00072');
    await setOnHand(p, storeId, 10);
    const created = await post('/reservations', {
      productId: p,
      locationId: storeId,
      quantity: 5,
    }).expect(201);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => post(`/reservations/${created.body.id}/release`, {}, null)),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    expect(await stockOf(p, storeId)).toMatchObject({ onHand: 10, reserved: 0 });
  });

  it('cannot reserve more than is available', async () => {
    const p = await productId('RP-00073');
    await setOnHand(p, storeId, 5);
    const res = await post('/reservations', {
      productId: p,
      locationId: storeId,
      quantity: 6,
    }).expect(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await stockOf(p, storeId)).toMatchObject({ reserved: 0 });
    const { rows } = await db.query(
      'SELECT COUNT(*)::int AS n FROM reservations WHERE product_id = $1',
      [p],
    );
    expect(rows[0].n).toBe(0);
  });

  it('is idempotent: a retry does not reserve twice', async () => {
    const p = await productId('RP-00074');
    await setOnHand(p, storeId, 10);
    const key = randomUUID();
    const body = { productId: p, locationId: storeId, quantity: 2 };
    const first = await post('/reservations', body, key).expect(201);
    const retry = await post('/reservations', body, key).expect(201);
    expect(retry.body.id).toBe(first.body.id);
    expect(await stockOf(p, storeId)).toMatchObject({ reserved: 2 });
    await post(`/reservations/${first.body.id}/release`, {}, null).expect(201);
  });

  it('lists and filters reservations; 404 for unknown ids', async () => {
    const p = await productId('RP-00075');
    await setOnHand(p, storeId, 10);
    const created = await post('/reservations', {
      productId: p,
      locationId: storeId,
      quantity: 1,
    }).expect(201);
    const list = await get(`/reservations?productId=${p}&status=ACTIVE`).expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.data[0]).toMatchObject({ id: created.body.id, sku: 'RP-00075' });
    await get(`/reservations/${MISSING_ID}`).expect(404);
    await post(`/reservations/${MISSING_ID}/release`, {}, null).expect(404);
    await post(`/reservations/${created.body.id}/release`, {}, null).expect(201);
  });
});

// ------------------------------------------------------------ whole-system invariant

describe('after all of the above', () => {
  it('every balance equals the sum of its ledger rows', async () => {
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

  it('reserved stock equals the sum of ACTIVE reservations', async () => {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS mismatches
         FROM inventory_balances b
         LEFT JOIN (SELECT product_id, location_id, SUM(quantity) AS q
                      FROM reservations WHERE status = 'ACTIVE' GROUP BY 1, 2) r
              USING (product_id, location_id)
        WHERE b.reserved <> COALESCE(r.q, 0)`,
    );
    expect(rows[0].mismatches).toBe(0);
  });

  it('every sales order total equals the sum of its lines', async () => {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS mismatches
         FROM sales_orders o
        WHERE o.total_amount <> (SELECT COALESCE(SUM(quantity * unit_price), 0)
                                   FROM sales_order_lines WHERE order_id = o.id)`,
    );
    expect(rows[0].mismatches).toBe(0);
  });

  it('every SALE ledger row points at an existing sales order', async () => {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS orphans
         FROM inventory_ledger e
        WHERE e.movement_type = 'SALE'
          AND NOT EXISTS (SELECT 1 FROM sales_orders o WHERE o.id::text = e.reference_id)`,
    );
    expect(rows[0].orphans).toBe(0);
  });
});
