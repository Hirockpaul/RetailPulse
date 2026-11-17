/**
 * Stock transfers: lifecycle, ledger effects, inbound, state guards, concurrency, scope.
 * REQUESTED → APPROVED → DISPATCHED → RECEIVED  (or CANCELLED before dispatch)
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

let app: INestApplication;
let db: pg.Client;
const cookies = {} as Record<keyof typeof DEMO, string>;
const loc = {} as Record<'str1' | 'str2' | 'dc', string>;
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

const as = (who: keyof typeof DEMO) => ({
  get: (url: string) =>
    request(app.getHttpServer()).get(`/api/v1${url}`).set('Cookie', cookies[who]),
  post: (url: string, body: object = {}, key: string | null = null) => {
    const req = request(app.getHttpServer()).post(`/api/v1${url}`).set('Cookie', cookies[who]);
    if (key !== null) req.set('Idempotency-Key', key);
    return req.send(body);
  },
});
const admin = () => as('admin');
const inv = () => as('inventory');

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
  await releaseTestDatabase();
});

// ------------------------------------------------------------------ helpers

async function productId(sku: string): Promise<string> {
  const res = await admin().get(`/products?q=${sku}`).expect(200);
  return res.body.data.find((p: { sku: string }) => p.sku === sku).id;
}

async function stock(product: string, location: string) {
  const rows = (await admin().get(`/products/${product}/stock`).expect(200)).body.data;
  const row = rows.find((r: { locationId: string }) => r.locationId === location);
  return { onHand: (row?.onHand ?? 0) as number, inbound: (row?.inbound ?? 0) as number };
}

async function setOnHand(product: string, location: string, target: number) {
  const { onHand } = await stock(product, location);
  if (onHand !== target) {
    await admin()
      .post(
        '/adjustments',
        { productId: product, locationId: location, delta: target - onHand, reason: 'test setup' },
        randomUUID(),
      )
      .expect(201);
  }
}

async function ledgerCount(product: string, query = ''): Promise<number> {
  return (await admin().get(`/products/${product}/ledger?pageSize=1${query}`).expect(200)).body
    .total;
}

type Who = keyof typeof DEMO;
async function createTransfer(
  who: Who,
  source: string,
  destination: string,
  product: string,
  quantity: number,
  notes?: string,
) {
  const res = await as(who)
    .post(
      '/transfers',
      {
        sourceLocationId: source,
        destinationLocationId: destination,
        notes,
        lines: [{ productId: product, quantity }],
      },
      randomUUID(),
    )
    .expect(201);
  return res.body as { id: string; status: string };
}

const act = (who: Who, id: string, step: 'approve' | 'dispatch' | 'receive' | 'cancel') =>
  as(who).post(`/transfers/${id}/${step}`);

/** Move a fresh transfer to the wanted status using the inventory manager. */
async function transferIn(
  status: 'REQUESTED' | 'APPROVED' | 'DISPATCHED' | 'RECEIVED' | 'CANCELLED',
  product: string,
  quantity = 1,
) {
  const t = await createTransfer('inventory', loc.dc, loc.str1, product, quantity);
  if (status === 'CANCELLED') await act('inventory', t.id, 'cancel').expect(201);
  if (status !== 'REQUESTED' && status !== 'CANCELLED')
    await act('inventory', t.id, 'approve').expect(201);
  if (status === 'DISPATCHED' || status === 'RECEIVED')
    await act('inventory', t.id, 'dispatch').expect(201);
  if (status === 'RECEIVED') await act('inventory', t.id, 'receive').expect(201);
  return t.id;
}

// -------------------------------------------------------------- lifecycle

describe('transfer lifecycle', () => {
  it('moves stock only through the ledger and shows inbound while in progress', async () => {
    const p = await productId('RP-00130');
    await setOnHand(p, loc.dc, 100);
    await setOnHand(p, loc.str1, 10);

    // REQUESTED — nothing moves, nothing inbound
    const created = await inv()
      .post(
        '/transfers',
        {
          sourceLocationId: loc.dc,
          destinationLocationId: loc.str1,
          notes: 'restock for weekend',
          lines: [{ productId: p, quantity: 30 }],
        },
        randomUUID(),
      )
      .expect(201);
    const id = created.body.id;
    expect(created.body).toMatchObject({
      status: 'REQUESTED',
      sourceCode: 'DC-NORTH',
      destinationCode: 'STR-01',
      requestedBy: 'Imani Inventory',
      approvedAt: null,
      lineCount: 1,
      totalUnits: 30,
      lines: [{ productId: p, sku: 'RP-00130', quantity: 30 }],
    });
    expect(await stock(p, loc.dc)).toEqual({ onHand: 100, inbound: 0 });
    expect(await stock(p, loc.str1)).toEqual({ onHand: 10, inbound: 0 });

    // APPROVED — still no stock movement, but 30 are now expected at the store
    const approved = await act('inventory', id, 'approve').expect(201);
    expect(approved.body).toMatchObject({ status: 'APPROVED', approvedBy: 'Imani Inventory' });
    expect(approved.body.approvedAt).toEqual(expect.any(String));
    expect(await stock(p, loc.dc)).toMatchObject({ onHand: 100 });
    expect(await stock(p, loc.str1)).toEqual({ onHand: 10, inbound: 30 });

    // DISPATCHED — leaves the DC (TRANSFER_OUT), not yet at the store: in transit
    const ledgerBefore = await ledgerCount(p);
    const dispatched = await act('admin', id, 'dispatch').expect(201);
    expect(dispatched.body).toMatchObject({ status: 'DISPATCHED', dispatchedBy: 'Avery Admin' });
    expect(await stock(p, loc.dc)).toEqual({ onHand: 70, inbound: 0 });
    expect(await stock(p, loc.str1)).toEqual({ onHand: 10, inbound: 30 });
    expect(await ledgerCount(p)).toBe(ledgerBefore + 1);
    const out = (await admin().get(`/products/${p}/ledger?movementType=TRANSFER_OUT`).expect(200))
      .body.data[0];
    expect(out).toMatchObject({
      locationCode: 'DC-NORTH',
      onHandDelta: -30,
      onHandAfter: 70,
      referenceType: 'TRANSFER',
      referenceId: id,
    });

    // RECEIVED — arrives (TRANSFER_IN); nothing inbound any more
    const received = await act('inventory', id, 'receive').expect(201);
    expect(received.body).toMatchObject({ status: 'RECEIVED', receivedBy: 'Imani Inventory' });
    expect(await stock(p, loc.str1)).toEqual({ onHand: 40, inbound: 0 });
    const inLedger = (
      await admin().get(`/products/${p}/ledger?movementType=TRANSFER_IN`).expect(200)
    ).body.data[0];
    expect(inLedger).toMatchObject({
      locationCode: 'STR-01',
      onHandDelta: 30,
      onHandAfter: 40,
      referenceId: id,
    });

    // Nothing was created or destroyed: DC + store is still 110.
    expect((await stock(p, loc.dc)).onHand + (await stock(p, loc.str1)).onHand).toBe(110);

    // The ledger rows record who did it.
    const { rows } = await db.query(
      `SELECT e.movement_type, u.email FROM inventory_ledger e JOIN users u ON u.id = e.actor_id
        WHERE e.reference_id = $1 ORDER BY e.id`,
      [id],
    );
    expect(rows).toEqual([
      { movement_type: 'TRANSFER_OUT', email: DEMO.admin },
      { movement_type: 'TRANSFER_IN', email: DEMO.inventory },
    ]);
  });

  it('can cancel a REQUESTED or APPROVED transfer without any stock change', async () => {
    const p = await productId('RP-00131');
    await setOnHand(p, loc.dc, 50);
    for (const via of ['REQUESTED', 'APPROVED'] as const) {
      const id = await transferIn(via, p, 5);
      const ledgerBefore = await ledgerCount(p);
      const res = await act('inventory', id, 'cancel').expect(201);
      expect(res.body).toMatchObject({ status: 'CANCELLED', cancelledBy: 'Imani Inventory' });
      expect(await ledgerCount(p)).toBe(ledgerBefore);
      expect(await stock(p, loc.str1)).toMatchObject({ inbound: 0 });
    }
    expect(await stock(p, loc.dc)).toMatchObject({ onHand: 50 });
  });

  it('handles several lines atomically', async () => {
    const [a, b] = await Promise.all([productId('RP-00132'), productId('RP-00133')]);
    await setOnHand(a, loc.dc, 40);
    await setOnHand(b, loc.dc, 3); // not enough for the second line
    const t = await inv()
      .post(
        '/transfers',
        {
          sourceLocationId: loc.dc,
          destinationLocationId: loc.str1,
          lines: [
            { productId: a, quantity: 10 },
            { productId: b, quantity: 8 },
          ],
        },
        randomUUID(),
      )
      .expect(201);
    expect(t.body).toMatchObject({ lineCount: 2, totalUnits: 18 });
    await act('inventory', t.body.id, 'approve').expect(201);

    // Second line cannot be covered → the whole dispatch fails, including the first line.
    const fail = await act('inventory', t.body.id, 'dispatch').expect(409);
    expect(fail.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await stock(a, loc.dc)).toMatchObject({ onHand: 40 });
    expect((await admin().get(`/transfers/${t.body.id}`).expect(200)).body.status).toBe('APPROVED');

    // After topping up, the same transfer can be dispatched.
    await setOnHand(b, loc.dc, 8);
    await act('inventory', t.body.id, 'dispatch').expect(201);
    expect(await stock(a, loc.dc)).toMatchObject({ onHand: 30 });
    expect(await stock(b, loc.dc)).toMatchObject({ onHand: 0 });
  });
});

// --------------------------------------------------------- state machine

describe('illegal transitions → 409 INVALID_STATE_TRANSITION', () => {
  const ILLEGAL: [
    'REQUESTED' | 'APPROVED' | 'DISPATCHED' | 'RECEIVED' | 'CANCELLED',
    'approve' | 'dispatch' | 'receive' | 'cancel',
  ][] = [
    ['REQUESTED', 'dispatch'],
    ['REQUESTED', 'receive'],
    ['APPROVED', 'approve'],
    ['APPROVED', 'receive'],
    ['DISPATCHED', 'approve'],
    ['DISPATCHED', 'dispatch'],
    ['DISPATCHED', 'cancel'],
    ['RECEIVED', 'approve'],
    ['RECEIVED', 'dispatch'],
    ['RECEIVED', 'receive'],
    ['RECEIVED', 'cancel'],
    ['CANCELLED', 'approve'],
    ['CANCELLED', 'dispatch'],
    ['CANCELLED', 'receive'],
    ['CANCELLED', 'cancel'],
  ];

  it.each(ILLEGAL)('a %s transfer cannot %s', async (status, step) => {
    const p = await productId('RP-00140');
    await setOnHand(p, loc.dc, 500);
    const id = await transferIn(status, p);
    const ledgerBefore = await ledgerCount(p);

    const res = await act('inventory', id, step).expect(409);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(res.body.error.message).toContain(status);
    expect((await admin().get(`/transfers/${id}`).expect(200)).body.status).toBe(status);
    expect(await ledgerCount(p)).toBe(ledgerBefore);
  });

  it('five simultaneous dispatches of one transfer move the stock exactly once', async () => {
    const p = await productId('RP-00141');
    await setOnHand(p, loc.dc, 100);
    const id = await transferIn('APPROVED', p, 10);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => act('admin', id, 'dispatch')),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 409);
    expect(rejected).toHaveLength(4);
    expect(rejected.every((r) => r.body.error.code === 'INVALID_STATE_TRANSITION')).toBe(true);
    expect(await stock(p, loc.dc)).toMatchObject({ onHand: 90 });
    expect(await ledgerCount(p, '&movementType=TRANSFER_OUT')).toBe(1);
  });

  it('404 for an unknown transfer on every step', async () => {
    for (const step of ['approve', 'dispatch', 'receive', 'cancel'] as const) {
      await act('admin', MISSING_ID, step).expect(404);
    }
    await admin().get(`/transfers/${MISSING_ID}`).expect(404);
  });

  it('the database itself rejects skipped or reversed statuses', async () => {
    const p = await productId('RP-00142');
    const requested = await transferIn('REQUESTED', p);
    const approved = await transferIn('APPROVED', p);

    await db.query('BEGIN');
    await expect(
      db.query(`UPDATE stock_transfers SET status = 'RECEIVED' WHERE id = $1`, [requested]),
    ).rejects.toMatchObject({ code: '23001', message: expect.stringMatching(/Illegal transfer/) });
    await db.query('ROLLBACK');

    await db.query('BEGIN');
    await expect(
      db.query(`UPDATE stock_transfers SET status = 'REQUESTED' WHERE id = $1`, [approved]),
    ).rejects.toMatchObject({ code: '23001' });
    await db.query('ROLLBACK');

    // A legal change that forgets its timestamp breaks the status/timestamp CHECK.
    await db.query('BEGIN');
    await expect(
      db.query(`UPDATE stock_transfers SET status = 'APPROVED' WHERE id = $1`, [requested]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'transfer_status_matches_timestamps' });
    await db.query('ROLLBACK');
  });
});

// ------------------------------------------------------------- creation

describe('creating transfers', () => {
  it('is idempotent: a retry returns the same transfer and creates one row', async () => {
    const p = await productId('RP-00150');
    const key = randomUUID();
    const notes = `idempotency-${key}`;
    const body = {
      sourceLocationId: loc.dc,
      destinationLocationId: loc.str1,
      notes,
      lines: [{ productId: p, quantity: 4 }],
    };
    const first = await inv().post('/transfers', body, key).expect(201);
    const retry = await inv().post('/transfers', body, key).expect(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.id).toBe(first.body.id);
    const { rows } = await db.query(
      'SELECT COUNT(*)::int AS n FROM stock_transfers WHERE notes = $1',
      [notes],
    );
    expect(rows[0].n).toBe(1);

    const reused = await inv()
      .post('/transfers', { ...body, lines: [{ productId: p, quantity: 5 }] }, key)
      .expect(422);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('requires an Idempotency-Key', async () => {
    const p = await productId('RP-00151');
    const res = await inv()
      .post('/transfers', {
        sourceLocationId: loc.dc,
        destinationLocationId: loc.str1,
        lines: [{ productId: p, quantity: 1 }],
      })
      .expect(400);
    expect(res.body.error.details[0].path).toBe('Idempotency-Key');
  });

  it('rejects bad input: same location, duplicate lines, unknown location or product', async () => {
    const p = await productId('RP-00152');
    const base = {
      sourceLocationId: loc.dc,
      destinationLocationId: loc.str1,
      lines: [{ productId: p, quantity: 1 }],
    };
    await inv()
      .post('/transfers', { ...base, destinationLocationId: loc.dc }, randomUUID())
      .expect(400);
    await inv()
      .post(
        '/transfers',
        {
          ...base,
          lines: [
            { productId: p, quantity: 1 },
            { productId: p, quantity: 2 },
          ],
        },
        randomUUID(),
      )
      .expect(400);
    await inv()
      .post('/transfers', { ...base, sourceLocationId: MISSING_ID }, randomUUID())
      .expect(404);
    await inv()
      .post('/transfers', { ...base, destinationLocationId: MISSING_ID }, randomUUID())
      .expect(404);

    const notes = `unknown-product-${randomUUID()}`;
    const res = await inv()
      .post(
        '/transfers',
        { ...base, notes, lines: [{ productId: MISSING_ID, quantity: 1 }] },
        randomUUID(),
      )
      .expect(404);
    expect(res.body.error.message).toMatch(/product/i);
    const { rows } = await db.query(
      'SELECT COUNT(*)::int AS n FROM stock_transfers WHERE notes = $1',
      [notes],
    );
    expect(rows[0].n).toBe(0); // rolled back completely
  });
});

// ---------------------------------------------------------- reads & lists

describe('reading transfers', () => {
  it('lists newest first with filters and pagination', async () => {
    const p = await productId('RP-00160');
    const a = await createTransfer('inventory', loc.dc, loc.str1, p, 1);
    const b = await createTransfer('inventory', loc.dc, loc.str2, p, 2);
    await act('inventory', b.id, 'approve').expect(201);

    const all = (await admin().get(`/transfers?productId=${p}&pageSize=100`).expect(200)).body;
    expect(all.total).toBe(2);
    expect(all.data.map((t: { id: string }) => t.id)).toEqual([b.id, a.id]);
    expect(all.data[0]).toMatchObject({ lineCount: 1, totalUnits: 2, status: 'APPROVED' });
    expect(all.data[0].lines).toBeUndefined(); // summaries stay small; detail has lines

    const approved = (await admin().get(`/transfers?productId=${p}&status=APPROVED`).expect(200))
      .body;
    expect(approved.data.map((t: { id: string }) => t.id)).toEqual([b.id]);
    const atStore1 = (
      await admin().get(`/transfers?productId=${p}&locationId=${loc.str1}`).expect(200)
    ).body;
    expect(atStore1.data.map((t: { id: string }) => t.id)).toEqual([a.id]);
    const page2 = (await admin().get(`/transfers?productId=${p}&pageSize=1&page=2`).expect(200))
      .body;
    expect(page2).toMatchObject({ total: 2, page: 2, pageSize: 1 });
    expect(page2.data.map((t: { id: string }) => t.id)).toEqual([a.id]);
  });

  it('analysts can read transfers but not act on them', async () => {
    const p = await productId('RP-00161');
    const t = await createTransfer('inventory', loc.dc, loc.str1, p, 1);
    await as('analyst').get(`/transfers/${t.id}`).expect(200);
    for (const step of ['approve', 'dispatch', 'receive', 'cancel'] as const) {
      await act('analyst', t.id, step).expect(403);
    }
  });
});

// ------------------------------------------------------ store manager scope

describe('store managers', () => {
  it('may request transfers INTO their own store only', async () => {
    const p = await productId('RP-00170');
    const ok = await as('store1')
      .post(
        '/transfers',
        {
          sourceLocationId: loc.dc,
          destinationLocationId: loc.str1,
          lines: [{ productId: p, quantity: 2 }],
        },
        randomUUID(),
      )
      .expect(201);
    expect(ok.body).toMatchObject({ status: 'REQUESTED', requestedBy: 'Sam Store-One' });

    const res = await as('store1')
      .post(
        '/transfers',
        {
          sourceLocationId: loc.dc,
          destinationLocationId: loc.str2,
          lines: [{ productId: p, quantity: 2 }],
        },
        randomUUID(),
      )
      .expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('cannot approve, but can receive at their own store after dispatch', async () => {
    const p = await productId('RP-00171');
    await setOnHand(p, loc.dc, 50);
    await setOnHand(p, loc.str1, 5);
    const t = await createTransfer('store1', loc.dc, loc.str1, p, 12);

    await act('store1', t.id, 'approve').expect(403); // role
    await act('inventory', t.id, 'approve').expect(201);
    await act('store2', t.id, 'dispatch').expect(403); // not their source store
    await act('inventory', t.id, 'dispatch').expect(201);

    await act('store2', t.id, 'receive').expect(403); // someone else's delivery
    const received = await act('store1', t.id, 'receive').expect(201);
    expect(received.body).toMatchObject({ status: 'RECEIVED', receivedBy: 'Sam Store-One' });
    expect(await stock(p, loc.str1)).toEqual({ onHand: 17, inbound: 0 });
  });

  it('can dispatch from their own store, and only the destination store receives', async () => {
    const p = await productId('RP-00172');
    await setOnHand(p, loc.str1, 30);
    await setOnHand(p, loc.str2, 0);
    const t = await createTransfer('store2', loc.str1, loc.str2, p, 10); // store2 asks store1 for stock
    await act('inventory', t.id, 'approve').expect(201);

    await act('store2', t.id, 'dispatch').expect(403); // store2 is the destination, not the source
    await act('store1', t.id, 'dispatch').expect(201);
    expect(await stock(p, loc.str1)).toMatchObject({ onHand: 20 });
    expect(await stock(p, loc.str2)).toEqual({ onHand: 0, inbound: 10 });

    await act('store1', t.id, 'receive').expect(403);
    await act('store2', t.id, 'receive').expect(201);
    expect(await stock(p, loc.str2)).toEqual({ onHand: 10, inbound: 0 });
  });

  it('can cancel transfers touching their store, but not other stores’ transfers', async () => {
    const p = await productId('RP-00173');
    const t = await createTransfer('store2', loc.dc, loc.str2, p, 3);
    await act('store1', t.id, 'cancel').expect(403);
    const res = await act('store2', t.id, 'cancel').expect(201);
    expect(res.body).toMatchObject({ status: 'CANCELLED', cancelledBy: 'Sky Store-Two' });
  });

  it('only see transfers that touch their stores', async () => {
    const p = await productId('RP-00174');
    const forStore1 = await createTransfer('inventory', loc.dc, loc.str1, p, 1);
    const forStore2 = await createTransfer('inventory', loc.dc, loc.str2, p, 1);

    await as('store1').get(`/transfers/${forStore1.id}`).expect(200);
    const denied = await as('store1').get(`/transfers/${forStore2.id}`).expect(403);
    expect(denied.body.error.code).toBe('FORBIDDEN');

    const list = (await as('store1').get(`/transfers?productId=${p}&pageSize=100`).expect(200))
      .body;
    expect(list.data.map((t: { id: string }) => t.id)).toEqual([forStore1.id]);
    expect(list.total).toBe(1);
  });
});

// ------------------------------------------------------ whole-system checks

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

  it('every dispatched or received transfer has matching ledger rows; units are conserved', async () => {
    const { rows } = await db.query(
      `SELECT t.id, t.status,
              (SELECT COALESCE(SUM(quantity), 0)::int FROM stock_transfer_lines WHERE transfer_id = t.id) AS units,
              COALESCE(-SUM(e.on_hand_delta) FILTER (WHERE e.movement_type = 'TRANSFER_OUT'), 0)::int AS out_units,
              COALESCE(SUM(e.on_hand_delta) FILTER (WHERE e.movement_type = 'TRANSFER_IN'), 0)::int AS in_units
         FROM stock_transfers t
         LEFT JOIN inventory_ledger e ON e.reference_type = 'TRANSFER' AND e.reference_id = t.id::text
        GROUP BY t.id`,
    );
    expect(rows.length).toBeGreaterThan(10);
    for (const r of rows) {
      const out = ['DISPATCHED', 'RECEIVED'].includes(r.status) ? r.units : 0;
      const into = r.status === 'RECEIVED' ? r.units : 0;
      expect({ id: r.id, out: r.out_units, in: r.in_units }).toEqual({ id: r.id, out, in: into });
    }
  });
});
