/**
 * V2 5e: the database integrity check (`npm run db:verify`), run as the real CLI against this
 * file's own throw-away database. Each rule is broken on purpose — with triggers and foreign keys
 * skipped (`session_replication_role = replica`), as a careless manual repair or a partial restore
 * would — and must be reported by name with exit code 1. Every break is undone afterwards.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import pg from 'pg';
import { prepareTestDatabase, releaseTestDatabase } from './test-db';

let url: string;
let db: pg.Client;

type Check = { name: string; status: 'PASS' | 'WARN' | 'FAIL'; detail: string };
type Result = { database: string; ok: boolean; results: Check[]; counts: Record<string, number> };

/** Runs the CLI against the test database; returns its exit code and parsed JSON. */
function verify(): { code: number; out: Result } {
  const r = spawnSync(
    process.execPath,
    [resolve(__dirname, '../../scripts/verify.mjs'), '--json'],
    {
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
    },
  );
  return { code: r.status ?? -1, out: JSON.parse(r.stdout) as Result };
}
const statusOf = (out: Result, name: string) => out.results.find((c) => c.name === name)!.status;

/** Run SQL with triggers and foreign-key checks skipped, like a hand-made repair. */
async function unsafely(sql: string, params: unknown[] = []) {
  await db.query('SET session_replication_role = replica');
  try {
    await db.query(sql, params);
  } finally {
    await db.query('SET session_replication_role = origin');
  }
}

beforeAll(async () => {
  url = await prepareTestDatabase();
  db = new pg.Client({ connectionString: url });
  await db.connect();
}, 60_000);

afterAll(async () => {
  await db?.end();
  await releaseTestDatabase();
});

describe('db:verify (V2 5e)', () => {
  it('a freshly migrated and seeded database passes every check and is not changed', async () => {
    const before = (await db.query('SELECT count(*)::int AS n FROM inventory_ledger')).rows[0].n;
    const { code, out } = verify();
    expect(code).toBe(0);
    expect(out.ok).toBe(true);
    expect(out.results.map((c) => [c.name, c.status])).toEqual([
      ['balances equal the ledger', 'PASS'],
      ['every ledger row has a balance', 'PASS'],
      ['no negative stock', 'PASS'],
      ['outbox: processed ⇔ processed_at', 'PASS'],
      ['outbox: consumer receipts point at events', 'PASS'],
      ['outbox: nothing stuck', 'PASS'],
      ['migrations match the files', 'PASS'],
    ]);
    expect(out.counts.inventory_balances).toBeGreaterThan(0);
    expect(out.counts.inventory_ledger).toBe(before);
  });

  it('a balance that disagrees with its ledger fails', async () => {
    const b = (await db.query('SELECT product_id, location_id FROM inventory_balances LIMIT 1'))
      .rows[0];
    await unsafely(
      'UPDATE inventory_balances SET on_hand = on_hand + 1 WHERE product_id = $1 AND location_id = $2',
      [b.product_id, b.location_id],
    );
    const { code, out } = verify();
    expect(code).toBe(1);
    expect(statusOf(out, 'balances equal the ledger')).toBe('FAIL');
    expect(statusOf(out, 'no negative stock')).toBe('PASS');
    await unsafely(
      'UPDATE inventory_balances SET on_hand = on_hand - 1 WHERE product_id = $1 AND location_id = $2',
      [b.product_id, b.location_id],
    );
    expect(verify().code).toBe(0);
  });

  it('negative stock and reservations beyond stock fail (even where a constraint was lost)', async () => {
    // The database itself forbids this (CHECK constraint), so the check is defence in depth, e.g.
    // for a database restored without its constraints: drop it here, then put it back unchanged.
    const def = (
      await db.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conname = 'inventory_reserved_within_on_hand'`,
      )
    ).rows[0].def as string;
    const b = (
      await db.query('SELECT product_id, location_id FROM inventory_balances LIMIT 1 OFFSET 1')
    ).rows[0];
    await db.query(
      'ALTER TABLE inventory_balances DROP CONSTRAINT inventory_reserved_within_on_hand',
    );
    try {
      await unsafely(
        'UPDATE inventory_balances SET reserved = on_hand + 1 WHERE product_id = $1 AND location_id = $2',
        [b.product_id, b.location_id],
      );
      const { code, out } = verify();
      expect(code).toBe(1);
      expect(statusOf(out, 'no negative stock')).toBe('FAIL');
    } finally {
      await unsafely(
        'UPDATE inventory_balances SET reserved = 0 WHERE product_id = $1 AND location_id = $2',
        [b.product_id, b.location_id],
      );
      await db.query(
        `ALTER TABLE inventory_balances ADD CONSTRAINT inventory_reserved_within_on_hand ${def}`,
      );
    }
    expect(verify().code).toBe(0);
  });

  it('a ledger row without a balance fails', async () => {
    const g = (await db.query('SELECT product_id, location_id FROM inventory_ledger LIMIT 1'))
      .rows[0];
    const saved = (
      await db.query(
        'SELECT * FROM inventory_balances WHERE product_id = $1 AND location_id = $2',
        [g.product_id, g.location_id],
      )
    ).rows[0];
    await unsafely('DELETE FROM inventory_balances WHERE product_id = $1 AND location_id = $2', [
      g.product_id,
      g.location_id,
    ]);
    const { code, out } = verify();
    expect(code).toBe(1);
    expect(statusOf(out, 'every ledger row has a balance')).toBe('FAIL');
    const cols = Object.keys(saved);
    await unsafely(
      `INSERT INTO inventory_balances (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
      cols.map((c) => saved[c]),
    );
    expect(verify().code).toBe(0);
  });

  it('outbox: a receipt for a missing event fails; an event pending for hours only warns', async () => {
    await unsafely(`INSERT INTO processed_events (consumer, event_id) VALUES ('test', $1)`, [
      randomUUID(),
    ]);
    let r = verify();
    expect(r.code).toBe(1);
    expect(statusOf(r.out, 'outbox: consumer receipts point at events')).toBe('FAIL');
    await unsafely(`DELETE FROM processed_events WHERE consumer = 'test'`);

    const id = randomUUID();
    await unsafely(
      `INSERT INTO outbox_events (id, event_type, aggregate_type, aggregate_id, payload, occurred_at,
          status, created_at)
       VALUES ($1, 'test.event', 'test', 'x', '{}', now() - interval '2 hours', 'PENDING',
               now() - interval '2 hours')`,
      [id],
    );
    r = verify();
    expect(r.code).toBe(0); // the worker retries: a warning, not a failure
    expect(statusOf(r.out, 'outbox: nothing stuck')).toBe('WARN');
    await unsafely('DELETE FROM outbox_events WHERE id = $1', [id]);
    expect(verify().out.results.every((c) => c.status === 'PASS')).toBe(true);
  });

  it('a changed, missing or unknown migration fails', async () => {
    const first = (
      await db.query('SELECT name, checksum FROM schema_migrations ORDER BY name LIMIT 1')
    ).rows[0];
    await db.query(`UPDATE schema_migrations SET checksum = 'edited' WHERE name = $1`, [
      first.name,
    ]);
    await db.query(
      `INSERT INTO schema_migrations (name, checksum) VALUES ('9999_unknown.sql', 'x')`,
    );
    const { code, out } = verify();
    expect(code).toBe(1);
    const m = out.results.find((c) => c.name === 'migrations match the files')!;
    expect(m.status).toBe('FAIL');
    expect(m.detail).toContain('1 changed, 1 unknown');
    await db.query('UPDATE schema_migrations SET checksum = $2 WHERE name = $1', [
      first.name,
      first.checksum,
    ]);
    await db.query(`DELETE FROM schema_migrations WHERE name = '9999_unknown.sql'`);
    expect(verify().code).toBe(0);
  });
});
