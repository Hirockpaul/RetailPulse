/**
 * Day 7: housekeeping deletes old bookkeeping rows (processed outbox events, idempotency keys)
 * and nothing else. Rows are aged by back-dating their processing timestamps.
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
import { HousekeepingService } from '../../src/modules/housekeeping/housekeeping.service';
import { DEMO, login } from './auth-helpers';
import { prepareTestDatabase, releaseTestDatabase } from './test-db';

let url: string;
let app: INestApplication;
let db: pg.Client;
let cookie: string;
let housekeeping: HousekeepingService;
let dispatcher: EventDispatcher;
let saleBody: { locationId: string; lines: { productId: string; quantity: number }[] };

const sell = (key: string) =>
  request(app.getHttpServer())
    .post('/api/v1/sales')
    .set('Cookie', cookie)
    .set('Idempotency-Key', key)
    .send(saleBody);

const n = async (sql: string, params: unknown[] = []): Promise<number> =>
  (await db.query(sql, params)).rows[0].n;

beforeAll(async () => {
  url = await prepareTestDatabase();
  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: url });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).compile();
  app = configureApp(moduleRef.createNestApplication({ logger: false }));
  await app.init();
  housekeeping = app.get(HousekeepingService);
  dispatcher = app.get(EventDispatcher);
  db = new pg.Client({ connectionString: url });
  await db.connect();
  cookie = await login(app, DEMO.admin);

  const auth = (path: string) =>
    request(app.getHttpServer()).get(`/api/v1${path}`).set('Cookie', cookie);
  const stores = (await auth('/locations?type=STORE').expect(200)).body.data;
  const product = (await auth('/products?sort=available:desc&pageSize=1').expect(200)).body.data[0];
  saleBody = { locationId: stores[0].id, lines: [{ productId: product.id, quantity: 1 }] };
}, 60_000);

afterAll(async () => {
  await db?.end();
  await app?.close();
  await releaseTestDatabase();
});

describe('housekeeping', () => {
  it('purges old processed events and keys; keeps recent ones, dead letters and business data', async () => {
    const oldKey = randomUUID();
    const newKey = randomUUID();
    await sell(oldKey).expect(201);
    await sell(newKey).expect(201);
    await dispatcher.runOnce(5000);

    // Age everything except the second sale's event and key.
    const newEvent = await db.query(
      `SELECT e.id FROM outbox_events e
        WHERE e.payload->>'referenceId' = (
          SELECT response_body->>'id' FROM idempotency_keys WHERE key = $1)`,
      [newKey],
    );
    expect(newEvent.rowCount).toBe(1);
    await db.query(
      `UPDATE outbox_events SET processed_at = now() - interval '8 days'
        WHERE status = 'PROCESSED' AND id <> $1`,
      [newEvent.rows[0].id],
    );
    await db.query(
      `UPDATE idempotency_keys SET created_at = now() - interval '8 days' WHERE key <> $1`,
      [newKey],
    );
    // An old dead letter must survive: operators still need to see and replay it.
    const deadId = randomUUID();
    await db.query(
      `INSERT INTO outbox_events (id, event_type, aggregate_type, aggregate_id, payload, occurred_at,
          status, attempts, last_error, created_at)
       VALUES ($1, 'test.dead', 'test', 'x', '{}', now() - interval '30 days', 'DEAD', 3, 'boom',
               now() - interval '30 days')`,
      [deadId],
    );

    const ledgerBefore = await n('SELECT COUNT(*)::int AS n FROM inventory_ledger');
    const alertsBefore = await n('SELECT COUNT(*)::int AS n FROM alerts');
    const oldEvents = await n(
      `SELECT COUNT(*)::int AS n FROM outbox_events WHERE status = 'PROCESSED' AND id <> $1`,
      [newEvent.rows[0].id],
    );
    const oldKeys = await n('SELECT COUNT(*)::int AS n FROM idempotency_keys WHERE key <> $1', [
      newKey,
    ]);
    expect(oldEvents).toBeGreaterThan(0);

    const result = await housekeeping.runOnce();
    expect(result).toEqual({ outboxEvents: oldEvents, idempotencyKeys: oldKeys });

    expect(await n(`SELECT COUNT(*)::int AS n FROM outbox_events WHERE status = 'PROCESSED'`)).toBe(
      1,
    );
    expect(await n('SELECT COUNT(*)::int AS n FROM processed_events')).toBe(
      await n(
        `SELECT COUNT(*)::int AS n FROM processed_events p JOIN outbox_events e ON e.id = p.event_id`,
      ),
    );
    expect(await n('SELECT COUNT(*)::int AS n FROM outbox_events WHERE id = $1', [deadId])).toBe(1);
    expect(await n('SELECT COUNT(*)::int AS n FROM idempotency_keys')).toBe(1);
    expect(await n('SELECT COUNT(*)::int AS n FROM inventory_ledger')).toBe(ledgerBefore);
    expect(await n('SELECT COUNT(*)::int AS n FROM alerts')).toBe(alertsBefore);

    // Running again finds nothing more to do.
    expect(await housekeeping.runOnce()).toEqual({ outboxEvents: 0, idempotencyKeys: 0 });
  });

  it('within the retention window a retry still replays; after it, the key is forgotten', async () => {
    const key = randomUUID();
    const first = await sell(key).expect(201);
    const replay = await sell(key).expect(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.id).toBe(first.body.id);

    await housekeeping.runOnce(); // key is fresh: kept
    expect((await sell(key).expect(201)).headers['idempotent-replayed']).toBe('true');

    await db.query(
      `UPDATE idempotency_keys SET created_at = now() - interval '8 days' WHERE key = $1`,
      [key],
    );
    await housekeeping.runOnce();
    const late = await sell(key).expect(201); // documented: a retry after 7 days is a new request
    expect(late.headers['idempotent-replayed']).toBeUndefined();
    expect(late.body.id).not.toBe(first.body.id);
  });
});
