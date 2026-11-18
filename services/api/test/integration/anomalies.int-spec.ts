/**
 * V2 step 1e-2: anomaly findings (sales from the forecasting service, operations from the event
 * consumer) and the review workflow — against a real PostgreSQL.
 */
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { loadEnv } from '../../src/core/config/env';
import { EventDispatcher } from '../../src/modules/events/event-dispatcher';
import { DEMO, login } from './auth-helpers';
import { prepareTestDatabase, releaseTestDatabase } from './test-db';

let url: string;
let app: INestApplication;
let db: pg.Client;
let dispatcher: EventDispatcher;
const cookies = {} as Record<keyof typeof DEMO, string>;
let str1: string;
let str2: string;
let products: { id: string; sku: string }[];

const as = (who: keyof typeof DEMO) => ({
  get: (path: string) =>
    request(app.getHttpServer()).get(`/api/v1${path}`).set('Cookie', cookies[who]),
  post: (path: string, body: object = {}, key?: string) => {
    const req = request(app.getHttpServer()).post(`/api/v1${path}`).set('Cookie', cookies[who]);
    if (key) req.set('Idempotency-Key', key);
    return req.send(body);
  },
});

beforeAll(async () => {
  url = await prepareTestDatabase();
  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: url });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).compile();
  app = configureApp(moduleRef.createNestApplication({ logger: false }));
  await app.init();
  dispatcher = app.get(EventDispatcher);
  db = new pg.Client({ connectionString: url });
  await db.connect();
  for (const who of Object.keys(DEMO) as (keyof typeof DEMO)[])
    cookies[who] = await login(app, DEMO[who]);
  const locations = (await as('admin').get('/locations?pageSize=100').expect(200)).body.data;
  const idOf = (code: string) => locations.find((l: { code: string }) => l.code === code).id;
  str1 = idOf('STR-01');
  str2 = idOf('STR-02');
  products = (await as('admin').get('/products?sort=sku:asc&pageSize=10').expect(200)).body.data;
}, 60_000);

afterAll(async () => {
  await db?.end();
  await app?.close();
  await releaseTestDatabase();
});

/** A sales finding, written as the forecasting service would. */
async function salesFinding(productId: string, locationId: string, severity = 'HIGH') {
  const { rows } = await db.query(
    `INSERT INTO forecast.anomaly_detections (product_id, location_id, day, kind, severity, score,
        observed, expected, method, rule, explanation)
     VALUES ($1, $2, current_date - (random() * 80)::int, 'SPIKE', $3, 12.5, 60, 5,
             'robust_z', 'v1', 'Sold 60 units; about 5 were expected.')
     RETURNING id`,
    [productId, locationId, severity],
  );
  return rows[0].id as string;
}

const count = async (sql: string, params: unknown[] = []) =>
  Number((await db.query(sql, params)).rows[0].n);

async function move(path: string, body: object) {
  await as('admin').post(path, body, randomUUID()).expect(201);
}

describe('listing and reading findings', () => {
  let id: string;
  beforeAll(async () => {
    id = await salesFinding(products[0].id, str1);
  });

  it('shows a new finding with product and store, to every role, store-scoped', async () => {
    const res = (await as('analyst').get('/anomalies?source=SALES').expect(200)).body;
    expect(res.data.find((f: { id: string }) => f.id === id)).toMatchObject({
      status: 'NEW',
      kind: 'SPIKE',
      severity: 'HIGH',
      locationCode: 'STR-01',
      sku: products[0].sku,
      observed: 60,
      expected: 5,
    });
    const store2 = (await as('store2').get('/anomalies').expect(200)).body.data;
    expect(store2.some((f: { id: string }) => f.id === id)).toBe(false);
    await as('store2').get(`/anomalies/${id}`).expect(403);
    await as('store2').get(`/anomalies?locationId=${str1}`).expect(403);
    const detail = (await as('store1').get(`/anomalies/${id}`).expect(200)).body;
    expect(detail).toMatchObject({
      history: [],
      nextSteps: ['INVESTIGATING', 'CONFIRMED', 'DISMISSED'],
    });
    const asAnalyst = (await as('analyst').get(`/anomalies/${id}`).expect(200)).body;
    expect(asAnalyst.nextSteps).toEqual([]); // analysts read only
  });

  it('validates ids, filters and sort', async () => {
    await as('admin').get('/anomalies/not-a-uuid').expect(400);
    await as('admin').get(`/anomalies/${randomUUID()}`).expect(404);
    await as('admin').get('/anomalies?status=MAYBE').expect(400);
    await as('admin').get('/anomalies?sort=price:asc').expect(400);
    await as('admin')
      .get('/anomalies?status=OPEN&severity=HIGH&kind=SPIKE&sort=day:desc')
      .expect(200);
  });
});

describe('the review workflow', () => {
  it('NEW → INVESTIGATING → CONFIRMED → RESOLVED, with who, when and why', async () => {
    const id = await salesFinding(products[1].id, str1);
    await as('store1').post(`/anomalies/${id}/review`, { status: 'INVESTIGATING' }).expect(200);
    await as('store1').post(`/anomalies/${id}/review`, { status: 'CONFIRMED' }).expect(400); // note
    await as('store1')
      .post(`/anomalies/${id}/review`, { status: 'CONFIRMED', note: 'Local event, real demand' })
      .expect(200);
    const done = (
      await as('inventory')
        .post(`/anomalies/${id}/review`, { status: 'RESOLVED', note: 'Order adjusted' })
        .expect(200)
    ).body;
    expect(done).toMatchObject({ status: 'RESOLVED', nextSteps: [] });
    expect(
      done.history.map(
        (h: { fromStatus: string; toStatus: string }) => `${h.fromStatus}>${h.toStatus}`,
      ),
    ).toEqual(['NEW>INVESTIGATING', 'INVESTIGATING>CONFIRMED', 'CONFIRMED>RESOLVED']);
    expect(done.history[1]).toMatchObject({
      note: 'Local event, real demand',
      actor: expect.any(String),
    });
    const res = await as('admin')
      .post(`/anomalies/${id}/review`, { status: 'INVESTIGATING' })
      .expect(409);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('dismissing is final; skipping steps is refused', async () => {
    const id = await salesFinding(products[2].id, str1);
    await as('admin')
      .post(`/anomalies/${id}/review`, { status: 'RESOLVED', note: 'skip' })
      .expect(409);
    await as('admin')
      .post(`/anomalies/${id}/review`, { status: 'DISMISSED', note: 'Normal Saturday rush' })
      .expect(200);
    await as('admin').post(`/anomalies/${id}/review`, { status: 'INVESTIGATING' }).expect(409);
    expect(
      (await as('admin').get('/anomalies?status=OPEN&pageSize=100').expect(200)).body.data.some(
        (f: { id: string }) => f.id === id,
      ),
    ).toBe(false);
  });

  it('only people who may act on that store can review', async () => {
    const id = await salesFinding(products[3].id, str1);
    await as('analyst').post(`/anomalies/${id}/review`, { status: 'INVESTIGATING' }).expect(403);
    await as('store2').post(`/anomalies/${id}/review`, { status: 'INVESTIGATING' }).expect(403);
    await as('store1').post(`/anomalies/${id}/review`, { status: 'INVESTIGATING' }).expect(200);
  });

  it('five people deciding at the same moment: exactly one decision is recorded', async () => {
    const id = await salesFinding(products[4].id, str2);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        as('admin').post(`/anomalies/${id}/review`, { status: 'INVESTIGATING' }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    expect(
      await count(
        `SELECT COUNT(*) AS n FROM anomaly_review_events e JOIN anomaly_reviews r ON r.id = e.review_id
          WHERE r.sales_detection_id = $1`,
        [id],
      ),
    ).toBe(1);
  });

  it('the database itself refuses skipped steps and edits to the history', async () => {
    const id = await salesFinding(products[5].id, str2);
    await as('admin')
      .post(`/anomalies/${id}/review`, { status: 'DISMISSED', note: 'Normal' })
      .expect(200);
    await expect(
      db.query(
        `UPDATE anomaly_reviews SET status = 'INVESTIGATING' WHERE sales_detection_id = $1`,
        [id],
      ),
    ).rejects.toThrow(/cannot go from DISMISSED to INVESTIGATING/);
    await expect(db.query(`UPDATE anomaly_review_events SET note = 'x'`)).rejects.toThrow(
      /append-only/,
    );
  });

  it('reviewing never changes stock', async () => {
    const id = await salesFinding(products[6].id, str2);
    const before = await count('SELECT COUNT(*) AS n FROM inventory_ledger');
    await as('admin').post(`/anomalies/${id}/review`, { status: 'INVESTIGATING' }).expect(200);
    await as('admin')
      .post(`/anomalies/${id}/review`, { status: 'CONFIRMED', note: 'Shrinkage' })
      .expect(200);
    expect(await count('SELECT COUNT(*) AS n FROM inventory_ledger')).toBe(before);
  });
});

describe('operational anomalies from stock movements (event consumer)', () => {
  const ops = async (productId: string, kind: string) =>
    count(
      `SELECT COUNT(*) AS n FROM operational_anomalies WHERE product_id = $1 AND location_id = $2 AND kind = $3`,
      [productId, str2, kind],
    );

  it('a large write-off is flagged, with the numbers behind it', async () => {
    const p = products[7].id;
    await move('/receipts', { locationId: str2, lines: [{ productId: p, quantity: 60 }] });
    await move('/adjustments', { locationId: str2, productId: p, delta: -55, reason: 'Count' });
    await dispatcher.runOnce(5000);
    expect(await ops(p, 'LARGE_WRITE_OFF')).toBe(1);
    const list = (await as('admin').get(`/anomalies?source=OPERATIONS&productId=${p}`).expect(200))
      .body.data;
    expect(list[0]).toMatchObject({
      kind: 'LARGE_WRITE_OFF',
      severity: 'HIGH',
      observed: 55,
      details: expect.objectContaining({ removed: 55 }),
    });
    expect(list[0].explanation).toMatch(/removed 55 units at once/);
  });

  it('repeated small corrections are flagged once per window, not once per adjustment', async () => {
    const p = products[8].id;
    await move('/receipts', { locationId: str2, lines: [{ productId: p, quantity: 40 }] });
    for (let i = 0; i < 2; i++)
      await move('/adjustments', { locationId: str2, productId: p, delta: -1, reason: 'Count' });
    await dispatcher.runOnce(5000);
    expect(await ops(p, 'FREQUENT_ADJUSTMENTS')).toBe(0); // 2 is normal
    for (let i = 0; i < 3; i++)
      await move('/adjustments', { locationId: str2, productId: p, delta: -1, reason: 'Count' });
    await dispatcher.runOnce(5000);
    expect(await ops(p, 'FREQUENT_ADJUSTMENTS')).toBe(1); // 3rd crossed the line; 4th and 5th did not add
    expect(await ops(p, 'LARGE_WRITE_OFF')).toBe(0);
  });

  it('many returns against few sales are flagged; replaying events adds nothing', async () => {
    const p = products[9].id;
    await move('/receipts', { locationId: str2, lines: [{ productId: p, quantity: 30 }] });
    await move('/sales', { locationId: str2, lines: [{ productId: p, quantity: 1 }] });
    for (let i = 0; i < 5; i++)
      await move('/returns', {
        locationId: str2,
        productId: p,
        quantity: 1,
        condition: i % 2 ? 'DAMAGED' : 'SELLABLE',
      });
    await dispatcher.runOnce(5000);
    expect(await ops(p, 'HIGH_RETURN_RATE')).toBe(1);

    const events = await db.query(
      `SELECT id FROM outbox_events WHERE payload->>'productId' = $1 AND payload->>'movementType' = 'RETURN'`,
      [p],
    );
    for (const e of events.rows) await as('admin').post(`/ops/events/${e.id}/replay`).expect(201);
    await dispatcher.runOnce(5000);
    expect(await ops(p, 'HIGH_RETURN_RATE')).toBe(1);
  });

  it('sales and receipts never create operational findings', async () => {
    expect(
      await count(
        `SELECT COUNT(*) AS n FROM operational_anomalies o JOIN outbox_events e ON e.id = o.source_event_id
          WHERE e.payload->>'movementType' NOT IN ('ADJUSTMENT', 'RETURN')`,
      ),
    ).toBe(0);
  });
});
