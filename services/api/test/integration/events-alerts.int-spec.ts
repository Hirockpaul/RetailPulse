/**
 * Day 5: transactional outbox, in-process worker, idempotent consumers, retries, dead letters,
 * and low-stock alerts — against a real, freshly seeded PostgreSQL (no message broker).
 */
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { loadEnv } from '../../src/core/config/env';
import { DatabaseService } from '../../src/core/database/database.service';
import { ConsumerRegistry } from '../../src/modules/events/consumer-registry';
import { EventDispatcher } from '../../src/modules/events/event-dispatcher';
import type { EventConsumer } from '../../src/modules/events/events.schemas';
import { EventsService } from '../../src/modules/events/events.service';
import { DEMO, login } from './auth-helpers';
import { prepareTestDatabase, releaseTestDatabase } from './test-db';

let url: string;
let app: INestApplication;
let db: pg.Client;
let dispatcher: EventDispatcher;
let registry: ConsumerRegistry;
let events: EventsService;
let database: DatabaseService;
const cookies = {} as Record<keyof typeof DEMO, string>;
const loc = {} as Record<'str1' | 'str2' | 'dc', string>;
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

const as = (who: keyof typeof DEMO) => ({
  get: (path: string) =>
    request(app.getHttpServer()).get(`/api/v1${path}`).set('Cookie', cookies[who]),
  post: (path: string, body: object = {}, key: string | null = randomUUID()) => {
    const req = request(app.getHttpServer()).post(`/api/v1${path}`).set('Cookie', cookies[who]);
    if (key !== null) req.set('Idempotency-Key', key);
    return req.send(body);
  },
});
const admin = () => as('admin');

async function buildApp(overrides: Record<string, string> = {}) {
  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: url, ...overrides });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).compile();
  const instance = configureApp(moduleRef.createNestApplication({ logger: false }));
  await instance.init();
  return instance;
}

beforeAll(async () => {
  url = await prepareTestDatabase();
  app = await buildApp(); // NODE_ENV=test → the worker is OFF; tests drive it with runOnce()
  dispatcher = app.get(EventDispatcher);
  registry = app.get(ConsumerRegistry);
  events = app.get(EventsService);
  database = app.get(DatabaseService);
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

// Every test starts with an empty queue, so its own events are the only ones in play.
beforeEach(async () => {
  await dispatcher.runOnce(5000);
});

// ------------------------------------------------------------------ helpers

const drain = () => dispatcher.runOnce(5000);

/** Products with a pack size of at least 6, so "below one pack" is easy to set up. */
let candidates: { id: string; sku: string; packSize: number }[] = [];
async function nextProduct() {
  if (candidates.length === 0) {
    const all = (await admin().get('/products?pageSize=100&sort=sku:asc').expect(200)).body.data;
    candidates = all.filter((p: { packSize: number }) => p.packSize >= 6).slice(10);
  }
  return candidates.shift()!;
}

async function onHand(product: string, location: string): Promise<number> {
  const rows = (await admin().get(`/products/${product}/stock`).expect(200)).body.data;
  return rows.find((r: { locationId: string }) => r.locationId === location)?.onHand ?? 0;
}

async function setOnHand(product: string, location: string, target: number) {
  const current = await onHand(product, location);
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

const sell = (
  product: string,
  quantity: number,
  location = loc.str1,
  who: keyof typeof DEMO = 'admin',
) => as(who).post('/sales', { locationId: location, lines: [{ productId: product, quantity }] });

async function alertsFor(product: string, location: string) {
  return (
    await admin()
      .get(`/alerts?productId=${product}&locationId=${location}&pageSize=100`)
      .expect(200)
  ).body.data as {
    kind: string;
    status: string;
    severity: string;
    details: Record<string, unknown>;
    resolvedAt: string | null;
  }[];
}

const count = async (sql: string, params: unknown[] = []): Promise<number> =>
  (await db.query(sql, params)).rows[0].n;

const outboxCount = () => count('SELECT COUNT(*)::int AS n FROM outbox_events');

/** Create an event the way a producer does: inside a transaction. */
const recordEvent = (
  eventType: string,
  payload: Record<string, unknown> = {},
  aggregateId = 'test',
) =>
  database.transaction((client) =>
    events.record(client, { eventType, aggregateType: 'test', aggregateId, payload }),
  );

async function withConsumer<T>(consumer: EventConsumer, run: () => Promise<T>): Promise<T> {
  registry.register(consumer);
  try {
    return await run();
  } finally {
    registry.unregister(consumer.name);
  }
}

async function eventRow(id: string) {
  return (await db.query('SELECT * FROM outbox_events WHERE id = $1', [id])).rows[0];
}

// ----------------------------------------------------------------- producing

describe('the outbox (producer side)', () => {
  it('a committed sale writes one event with the full envelope; nothing is delivered with the worker off', async () => {
    const p = await nextProduct();
    await setOnHand(p.id, loc.str1, 30);
    await drain();
    const before = await outboxCount();
    const alertsBefore = await count('SELECT COUNT(*)::int AS n FROM alerts');

    const sale = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Cookie', cookies.store1)
      .set('Idempotency-Key', randomUUID())
      .set('x-correlation-id', 'corr-outbox-12345')
      .send({ locationId: loc.str1, lines: [{ productId: p.id, quantity: 2 }] })
      .expect(201);

    // The sale itself worked although no worker is running: the event just queues.
    expect(await outboxCount()).toBe(before + 1);
    expect(await count('SELECT COUNT(*)::int AS n FROM alerts')).toBe(alertsBefore);

    const { rows } = await db.query(
      `SELECT o.*, e.id AS ledger_id, e.actor_id FROM outbox_events o
         JOIN inventory_ledger e ON e.id::text = o.payload->>'ledgerId'
        WHERE o.event_type = 'inventory.movement.recorded' AND e.reference_id = $1`,
      [sale.body.id],
    );
    expect(rows).toHaveLength(1);
    const ev = rows[0];
    expect(ev).toMatchObject({
      event_type: 'inventory.movement.recorded',
      schema_version: 1,
      aggregate_type: 'inventory_balance',
      aggregate_id: `${p.id}:${loc.str1}`,
      correlation_id: 'corr-outbox-12345',
      status: 'PENDING',
      attempts: 0,
    });
    expect(ev.id).toMatch(/^[0-9a-f-]{36}$/); // the eventId
    expect(ev.occurred_at).toBeInstanceOf(Date);
    expect(ev.payload).toMatchObject({
      productId: p.id,
      locationId: loc.str1,
      movementType: 'SALE',
      onHandDelta: -2,
      onHandAfter: 28,
      referenceType: 'SALES_ORDER',
      referenceId: sale.body.id,
      actorId: ev.actor_id,
    });
    // No free text (the ledger "reason") travels in events.
    expect(JSON.stringify(ev.payload)).not.toMatch(/POS sale|reason/i);
  });

  it('a rolled-back change writes no event', async () => {
    const p = await nextProduct();
    const q = await nextProduct();
    await setOnHand(p.id, loc.str1, 5);
    await setOnHand(q.id, loc.str1, 0);
    await drain();
    const before = await outboxCount();

    await sell(p.id, 6).expect(409); // not enough stock
    await as('admin')
      .post('/sales', {
        locationId: loc.str1,
        lines: [
          { productId: p.id, quantity: 1 }, // would succeed…
          { productId: q.id, quantity: 1 }, // …but this line fails, rolling back both
        ],
      })
      .expect(409);
    await sell(MISSING_ID, 1).expect(404);

    expect(await outboxCount()).toBe(before);
    expect(await onHand(p.id, loc.str1)).toBe(5);
  });

  it('an idempotent retry does not produce a second event', async () => {
    const p = await nextProduct();
    await setOnHand(p.id, loc.str1, 20);
    await drain();
    const before = await outboxCount();
    const key = randomUUID();
    const body = { locationId: loc.str1, lines: [{ productId: p.id, quantity: 3 }] };

    await admin().post('/sales', body, key).expect(201);
    await admin().post('/sales', body, key).expect(201); // replayed response
    expect(await outboxCount()).toBe(before + 1);
  });

  it('multi-line writes and transfers produce one event per ledger row', async () => {
    const [a, b] = [await nextProduct(), await nextProduct()];
    await setOnHand(a.id, loc.dc, 50);
    await setOnHand(b.id, loc.dc, 50);
    await drain();
    const before = await outboxCount();

    await admin()
      .post('/receipts', {
        locationId: loc.dc,
        lines: [
          { productId: a.id, quantity: 4 },
          { productId: b.id, quantity: 4 },
        ],
      })
      .expect(201);
    expect(await outboxCount()).toBe(before + 2);

    const t = await admin()
      .post(
        '/transfers',
        {
          sourceLocationId: loc.dc,
          destinationLocationId: loc.str1,
          lines: [{ productId: a.id, quantity: 5 }],
        },
        randomUUID(),
      )
      .expect(201);
    await admin().post(`/transfers/${t.body.id}/approve`, {}, null).expect(201);
    expect(await outboxCount()).toBe(before + 2); // requesting/approving moves no stock
    await admin().post(`/transfers/${t.body.id}/dispatch`, {}, null).expect(201);
    await admin().post(`/transfers/${t.body.id}/receive`, {}, null).expect(201);
    expect(await outboxCount()).toBe(before + 4); // TRANSFER_OUT + TRANSFER_IN
  });

  it('event content cannot be edited afterwards, but processing columns can', async () => {
    const id = await recordEvent('test.immutable', { n: 1 });
    await db.query('BEGIN');
    await expect(
      db.query(`UPDATE outbox_events SET payload = '{"n": 2}' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23001' });
    await db.query('ROLLBACK');
    await db.query(`UPDATE outbox_events SET last_error = 'fine' WHERE id = $1`, [id]);
    await drain();
  });
});

// ---------------------------------------------------------------- consuming

describe('low-stock alerts (consumer side)', () => {
  it('raises LOW_STOCK below one pack, OUT_OF_STOCK at zero, and resolves after a receipt', async () => {
    const p = await nextProduct();
    await setOnHand(p.id, loc.str1, p.packSize + 5);
    await drain();
    expect(await alertsFor(p.id, loc.str1)).toEqual([]); // healthy: nothing raised

    // Below one pack → LOW_STOCK
    await sell(p.id, 6).expect(201);
    const result = await drain();
    expect(result.processed).toBeGreaterThanOrEqual(1);
    const low = await alertsFor(p.id, loc.str1);
    expect(low).toHaveLength(1);
    expect(low[0]).toMatchObject({
      kind: 'LOW_STOCK',
      status: 'OPEN',
      severity: 'MEDIUM',
      details: {
        available: p.packSize - 1,
        packSize: p.packSize,
        onHand: p.packSize - 1,
        reserved: 0,
      },
    });

    // The inputs behind the alert point at the event that raised it.
    const eventId = low[0].details.eventId as string;
    expect((await eventRow(eventId)).status).toBe('PROCESSED');
    expect(
      await count('SELECT COUNT(*)::int AS n FROM processed_events WHERE event_id = $1', [eventId]),
    ).toBe(1);

    // Down to zero → LOW_STOCK is superseded by OUT_OF_STOCK (one open alert at a time)
    await sell(p.id, p.packSize - 1).expect(201);
    await drain();
    const out = await alertsFor(p.id, loc.str1);
    expect(out.filter((a) => a.status === 'OPEN').map((a) => a.kind)).toEqual(['OUT_OF_STOCK']);
    expect(out.find((a) => a.kind === 'OUT_OF_STOCK')).toMatchObject({ severity: 'HIGH' });
    expect(out.find((a) => a.kind === 'LOW_STOCK')).toMatchObject({ status: 'RESOLVED' });

    // Restocking resolves everything
    await admin()
      .post('/receipts', {
        locationId: loc.str1,
        lines: [{ productId: p.id, quantity: p.packSize * 2 }],
      })
      .expect(201);
    await drain();
    const after = await alertsFor(p.id, loc.str1);
    expect(after.filter((a) => a.status === 'OPEN')).toEqual([]);
    expect(after.every((a) => a.resolvedAt !== null)).toBe(true);
  });

  it('a healthy movement raises nothing, and reservations count against availability', async () => {
    const p = await nextProduct();
    await setOnHand(p.id, loc.str1, p.packSize * 3);
    await sell(p.id, 1).expect(201);
    await drain();
    expect(await alertsFor(p.id, loc.str1)).toEqual([]);

    // Reserving most of it makes "available" low even though on-hand is not.
    await admin()
      .post('/reservations', {
        productId: p.id,
        locationId: loc.str1,
        quantity: p.packSize * 3 - 2,
      })
      .expect(201);
    await drain();
    const [alert] = await alertsFor(p.id, loc.str1);
    expect(alert).toMatchObject({
      kind: 'LOW_STOCK',
      details: { available: 1, reserved: p.packSize * 3 - 2 },
    });
  });

  it('alerts are per location', async () => {
    const p = await nextProduct();
    await setOnHand(p.id, loc.str1, p.packSize * 2);
    await setOnHand(p.id, loc.str2, p.packSize * 2);
    await sell(p.id, p.packSize * 2, loc.str2).expect(201);
    await drain();
    expect(await alertsFor(p.id, loc.str1)).toEqual([]);
    expect((await alertsFor(p.id, loc.str2)).map((a) => a.kind)).toEqual(['OUT_OF_STOCK']);
  });

  it('a replayed event is skipped by the consumer: no duplicate alert, no second run', async () => {
    const p = await nextProduct();
    await setOnHand(p.id, loc.str1, p.packSize + 2);
    await drain();
    await sell(p.id, 5).expect(201);

    const calls: string[] = [];
    await withConsumer(
      {
        name: 'spy-replay',
        eventTypes: ['inventory.movement.recorded'],
        handle: async (event) => {
          calls.push(event.id);
        },
      },
      async () => {
        await drain();
        const [alert] = await alertsFor(p.id, loc.str1);
        const eventId = alert.details.eventId as string;
        expect(calls).toContain(eventId); // both consumers saw it the first time
        const callsBefore = calls.length;

        // Replay it (as an operator would after an incident).
        const replay = await admin().post(`/ops/events/${eventId}/replay`, {}, null).expect(201);
        expect(replay.body).toEqual({ id: eventId, status: 'PENDING' });
        await drain();

        expect(calls).toHaveLength(callsBefore); // neither consumer ran again
        expect((await eventRow(eventId)).status).toBe('PROCESSED');
        expect(
          await count('SELECT COUNT(*)::int AS n FROM processed_events WHERE event_id = $1', [
            eventId,
          ]),
        ).toBe(2); // one row per consumer, never two for the same consumer
        const openAlerts = (await alertsFor(p.id, loc.str1)).filter((a) => a.status === 'OPEN');
        expect(openAlerts).toHaveLength(1);
      },
    );
  });

  it('even a lost "handled" mark cannot create a second open alert (database guarantee)', async () => {
    const p = await nextProduct();
    await setOnHand(p.id, loc.str1, p.packSize + 1);
    await sell(p.id, 2).expect(201);
    await drain();
    await expect(
      db.query(
        `INSERT INTO alerts (kind, severity, product_id, location_id, message, details)
         VALUES ('LOW_STOCK', 'MEDIUM', $1, $2, 'duplicate', '{}')`,
        [p.id, loc.str1],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('rescan repairs alerts that did not come through events', async () => {
    const p = await nextProduct();
    const healthy = await nextProduct();
    await setOnHand(p.id, loc.str1, 2); // low
    await setOnHand(healthy.id, loc.str1, healthy.packSize * 2);
    await drain();
    await db.query('DELETE FROM alerts WHERE product_id = $1', [p.id]); // lost
    await db.query(
      `INSERT INTO alerts (kind, severity, product_id, location_id, message, details)
       VALUES ('OUT_OF_STOCK', 'HIGH', $1, $2, 'stale', '{}')`,
      [healthy.id, loc.str1],
    ); // wrong

    const res = await admin().post('/alerts/rescan', {}, null).expect(201);
    expect(res.body.evaluated).toBeGreaterThan(0);

    expect((await alertsFor(p.id, loc.str1)).map((a) => [a.kind, a.status])).toEqual([
      ['LOW_STOCK', 'OPEN'],
    ]);
    expect((await alertsFor(healthy.id, loc.str1)).map((a) => [a.kind, a.status])).toEqual([
      ['OUT_OF_STOCK', 'RESOLVED'],
    ]);
  });
});

// ------------------------------------------------------ failure handling

describe('retries and dead letters', () => {
  it('retries with backoff, then dead-letters after three attempts; replay recovers it', async () => {
    let healthy = false;
    await withConsumer(
      {
        name: 'poison-test',
        eventTypes: ['test.poison'],
        handle: async () => {
          if (!healthy) throw new Error('boom: cannot process this');
        },
      },
      async () => {
        const id = await recordEvent('test.poison', { n: 1 });

        // attempt 1 → retry later
        expect(await drain()).toMatchObject({ retried: 1, dead: 0, processed: 0 });
        let row = await eventRow(id);
        expect(row).toMatchObject({
          status: 'PENDING',
          attempts: 1,
          last_error: 'boom: cannot process this',
        });
        expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now());

        // not due yet → the worker leaves it alone
        expect(await drain()).toEqual({ processed: 0, retried: 0, dead: 0 });
        expect((await eventRow(id)).attempts).toBe(1);

        // attempt 2 (made due) → retry; attempt 3 → dead letter
        await db.query('UPDATE outbox_events SET next_attempt_at = now() WHERE id = $1', [id]);
        expect(await drain()).toMatchObject({ retried: 1 });
        await db.query('UPDATE outbox_events SET next_attempt_at = now() WHERE id = $1', [id]);
        expect(await drain()).toMatchObject({ dead: 1 });
        row = await eventRow(id);
        expect(row).toMatchObject({ status: 'DEAD', attempts: 3 });

        // dead events are left alone and are visible to operators
        expect(await drain()).toEqual({ processed: 0, retried: 0, dead: 0 });
        const dead = (await admin().get('/ops/events/dead').expect(200)).body;
        expect(dead.data.find((d: { id: string }) => d.id === id)).toMatchObject({
          eventType: 'test.poison',
          attempts: 3,
          lastError: 'boom: cannot process this',
        });
        const stats = (await admin().get('/ops/events').expect(200)).body;
        expect(stats.events.dead).toBeGreaterThanOrEqual(1);

        // after the bug is fixed, an operator replays it
        healthy = true;
        await admin().post(`/ops/events/${id}/replay`, {}, null).expect(201);
        expect(await drain()).toMatchObject({ processed: 1 });
        expect(await eventRow(id)).toMatchObject({
          status: 'PROCESSED',
          attempts: 0,
          last_error: null,
        });
      },
    );
  });

  it('a consumer that fails halfway leaves no partial writes behind', async () => {
    const p = await nextProduct();
    await withConsumer(
      {
        name: 'half-writes',
        eventTypes: ['test.partial'],
        handle: async (_event, client) => {
          await client.query(
            `INSERT INTO alerts (kind, severity, product_id, location_id, message, details)
             VALUES ('LOW_STOCK', 'MEDIUM', $1, $2, 'half written', '{}')`,
            [p.id, loc.str1],
          );
          throw new Error('failed after writing');
        },
      },
      async () => {
        const id = await recordEvent('test.partial');
        expect(await drain()).toMatchObject({ retried: 1 });
        expect(await alertsFor(p.id, loc.str1)).toEqual([]); // the consumer's write was rolled back
        expect(
          await count(
            `SELECT COUNT(*)::int AS n FROM processed_events WHERE consumer = 'half-writes'`,
          ),
        ).toBe(0); // and it is not marked as handled
        expect((await eventRow(id)).attempts).toBe(1);
      },
    );
    await db.query(
      `UPDATE outbox_events SET next_attempt_at = now() WHERE event_type = 'test.partial'`,
    );
    await drain(); // consumer gone → nothing to do → processed
  });

  it('a malformed movement event is dead-lettered by the real consumer', async () => {
    const id = await recordEvent('inventory.movement.recorded', { oops: true });
    for (let attempt = 1; attempt <= 3; attempt++) {
      await db.query('UPDATE outbox_events SET next_attempt_at = now() WHERE id = $1', [id]);
      await drain();
    }
    const row = await eventRow(id);
    expect(row.status).toBe('DEAD');
    expect(row.last_error).toMatch(/productId/);
  });

  it('an event nobody consumes is simply marked processed', async () => {
    const id = await recordEvent('test.nobody-listens');
    expect(await drain()).toMatchObject({ processed: 1 });
    expect(await eventRow(id)).toMatchObject({ status: 'PROCESSED' });
  });

  it('replay: 404 for unknown events, 409 for events that are still waiting', async () => {
    await admin().post(`/ops/events/${MISSING_ID}/replay`, {}, null).expect(404);
    const id = await recordEvent('test.waiting');
    const res = await admin().post(`/ops/events/${id}/replay`, {}, null).expect(409);
    expect(res.body.error.code).toBe('EVENT_ALREADY_PENDING');
    await drain();
  });
});

// ------------------------------------------------------------- concurrency

describe('several workers at once', () => {
  it('process every event exactly once (SKIP LOCKED)', async () => {
    const handled = new Map<string, number>();
    await withConsumer(
      {
        name: 'spy-concurrent',
        eventTypes: ['test.concurrent'],
        handle: async (event) => {
          handled.set(event.id, (handled.get(event.id) ?? 0) + 1);
          await new Promise((r) => setTimeout(r, 5)); // widen the race window
        },
      },
      async () => {
        const ids = await Promise.all(
          Array.from({ length: 30 }, (_, i) => recordEvent('test.concurrent', { i })),
        );
        const results = await Promise.all([drain(), drain(), drain()]);

        expect(results.reduce((n, r) => n + r.processed, 0)).toBe(30);
        expect(handled.size).toBe(30);
        expect([...handled.values()].every((n) => n === 1)).toBe(true);
        expect(
          await count(
            `SELECT COUNT(*)::int AS n FROM processed_events WHERE consumer = 'spy-concurrent'`,
          ),
        ).toBe(30);
        for (const id of ids) expect((await eventRow(id)).status).toBe('PROCESSED');
      },
    );
  });
});

describe('the background worker', () => {
  it('delivers events on its own, and stops cleanly', async () => {
    const p = await nextProduct();
    await setOnHand(p.id, loc.str1, p.packSize + 1);
    await drain();

    const worker = await buildApp({ EVENT_WORKER_ENABLED: 'true', EVENT_POLL_MS: '50' });
    try {
      const w = worker.get(EventDispatcher);
      expect(w.state()).toMatchObject({ enabled: true, pollMs: 50 });

      await sell(p.id, 3).expect(201); // the first app has no worker; the second one delivers

      // (Earlier rescans may have left resolved alerts behind; only the OPEN one matters.)
      let open: Awaited<ReturnType<typeof alertsFor>> = [];
      for (let i = 0; i < 100 && open.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
        open = (await alertsFor(p.id, loc.str1)).filter((a) => a.status === 'OPEN');
      }
      expect(open.map((a) => a.kind)).toEqual(['LOW_STOCK']);
      // lastRunAt is recorded when a pass over the queue finishes, a moment after the alert commits.
      for (let i = 0; i < 100 && w.state().lastRunAt === null; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(w.state().lastRunAt).not.toBeNull();
    } finally {
      await worker.close();
    }
    expect(worker.get(EventDispatcher).state().enabled).toBe(false);
  });
});

// ------------------------------------------------------------ access control

describe('who can see what', () => {
  it('store managers only see their own stores’ alerts; analysts can read all', async () => {
    const p = await nextProduct();
    for (const l of [loc.str1, loc.str2]) {
      await setOnHand(p.id, l, p.packSize * 2);
      await sell(p.id, p.packSize * 2 - 1, l).expect(201); // leaves 1 → low
    }
    await drain();

    const ids = (r: request.Response) =>
      r.body.data.map((a: { locationId: string }) => a.locationId);
    const mine = await as('store1').get(`/alerts?productId=${p.id}&status=OPEN`).expect(200);
    expect(new Set(ids(mine))).toEqual(new Set([loc.str1]));
    const theirs = await as('store2').get(`/alerts?productId=${p.id}&status=OPEN`).expect(200);
    expect(new Set(ids(theirs))).toEqual(new Set([loc.str2]));
    await as('store1').get(`/alerts?locationId=${loc.str2}`).expect(403);

    // Analysts see every location (a rescan may also have raised alerts in other stores).
    const all = await as('analyst').get(`/alerts?productId=${p.id}&status=OPEN`).expect(200);
    expect(ids(all)).toEqual(expect.arrayContaining([loc.str1, loc.str2]));
    const high = await admin().get('/alerts?status=OPEN&kind=OUT_OF_STOCK&pageSize=5').expect(200);
    expect(high.body.data.every((a: { severity: string }) => a.severity === 'HIGH')).toBe(true);
  });

  it('only admins and inventory managers can monitor events or rescan', async () => {
    for (const who of ['store1', 'analyst'] as const) {
      await as(who).get('/ops/events').expect(403);
      await as(who).get('/ops/events/dead').expect(403);
      await as(who).post(`/ops/events/${MISSING_ID}/replay`, {}, null).expect(403);
      await as(who).post('/alerts/rescan', {}, null).expect(403);
    }
    const res = await as('inventory').get('/ops/events').expect(200);
    expect(res.body).toMatchObject({
      events: {
        pending: expect.any(Number),
        retrying: expect.any(Number),
        processed: expect.any(Number),
        dead: expect.any(Number),
      },
      worker: { enabled: false, pollMs: 1000 },
    });
  });

  it('reports the backlog and its age while events wait', async () => {
    await drain();
    const empty = (await admin().get('/ops/events').expect(200)).body.events;
    expect(empty.pending).toBe(0);
    expect(empty.oldestPendingSeconds).toBeNull();

    await recordEvent('test.backlog');
    await recordEvent('test.backlog');
    const waiting = (await admin().get('/ops/events').expect(200)).body.events;
    expect(waiting.pending).toBe(2);
    expect(waiting.oldestPendingSeconds).toBeGreaterThanOrEqual(0);
    // The same backlog is exported to Prometheus (no session needed for /metrics).
    const metrics = (await request(app.getHttpServer()).get('/metrics').expect(200)).text;
    expect(metrics).toContain('retailpulse_outbox_events{state="pending"} 2');
    await drain();
    const after = (await admin().get('/ops/events').expect(200)).body.events;
    expect(after.pending).toBe(0);
    expect(after.lastProcessedAt).not.toBeNull();
  });
});

// ------------------------------------------------------ whole-system checks

describe('after all of the above', () => {
  it('every ledger row written through the API has exactly one event', async () => {
    await drain();
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS missing_or_duplicated
         FROM inventory_ledger e
        WHERE e.reference_type IS DISTINCT FROM 'SEED'
          AND (SELECT COUNT(*) FROM outbox_events o
                WHERE o.event_type = 'inventory.movement.recorded'
                  AND o.payload->>'ledgerId' = e.id::text) <> 1`,
    );
    expect(rows[0].missing_or_duplicated).toBe(0);
  });

  it('no inventory event is stuck, and every processed one has a handled mark', async () => {
    const { rows } = await db.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending,
              COUNT(*) FILTER (WHERE status = 'PROCESSED'
                  AND NOT EXISTS (SELECT 1 FROM processed_events x
                                   WHERE x.event_id = o.id AND x.consumer = 'low-stock-alerts'))::int
                AS unmarked
         FROM outbox_events o WHERE event_type = 'inventory.movement.recorded'
           AND payload ? 'ledgerId'`,
    );
    expect(rows[0]).toEqual({ pending: 0, unmarked: 0 });
  });

  it('balances still equal the sum of their ledger rows', async () => {
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
