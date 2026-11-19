// Read-only integrity check of a RetailPulse database (V2 5e). Exit code 1 when any check FAILs.
// Rules: docs/V2-PLAN.md step 5e. Runs inside a READ ONLY transaction; it never changes anything.
//
// Usage: npm run db:verify                    the database in DATABASE_URL
//        npm run db:verify -- --db=<name>     another database on the same server (e.g. a restore)
//        npm run db:verify -- --json          machine-readable result
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const rootEnv = resolve(here, '../../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v] = a.slice(2).split('=');
      return [k, v ?? true];
    }),
);
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set (copy .env.example to .env).');
  process.exit(2);
}
const url = new URL(process.env.DATABASE_URL);
if (typeof args.db === 'string') url.pathname = `/${args.db}`;
const database = url.pathname.slice(1);

/** One check: PASS, WARN (worth a look, not broken) or FAIL, with numbers and examples. */
const results = [];
const record = (name, status, detail, examples = []) =>
  results.push({ name, status, detail, examples: examples.slice(0, 5) });

const client = new pg.Client({ connectionString: url.toString() });
await client.connect();
try {
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');

  // 1. Balances equal the ledger.
  const balanceVsLedger = await client.query(`
    WITH l AS (
      SELECT product_id, location_id, SUM(on_hand_delta)::bigint AS on_hand,
             SUM(reserved_delta)::bigint AS reserved
        FROM inventory_ledger GROUP BY 1, 2),
    last AS (
      SELECT DISTINCT ON (product_id, location_id) product_id, location_id,
             on_hand_after, reserved_after
        FROM inventory_ledger ORDER BY product_id, location_id, id DESC)
    SELECT b.product_id::text AS product, b.location_id::text AS location,
           b.on_hand, b.reserved, COALESCE(l.on_hand, 0) AS ledger_on_hand,
           COALESCE(l.reserved, 0) AS ledger_reserved,
           last.on_hand_after, last.reserved_after
      FROM inventory_balances b
      LEFT JOIN l ON l.product_id = b.product_id AND l.location_id = b.location_id
      LEFT JOIN last ON last.product_id = b.product_id AND last.location_id = b.location_id
     WHERE b.on_hand <> COALESCE(l.on_hand, 0) OR b.reserved <> COALESCE(l.reserved, 0)
        OR (last.product_id IS NOT NULL
            AND (last.on_hand_after <> b.on_hand OR last.reserved_after <> b.reserved))`);
  const balances = (await client.query('SELECT count(*)::int AS n FROM inventory_balances')).rows[0]
    .n;
  record(
    'balances equal the ledger',
    balanceVsLedger.rowCount === 0 ? 'PASS' : 'FAIL',
    `${balances} balances; ${balanceVsLedger.rowCount} differ from the sum of their ledger rows or their latest ledger row`,
    balanceVsLedger.rows,
  );
  const orphans = await client.query(`
    SELECT DISTINCT g.product_id::text AS product, g.location_id::text AS location
      FROM inventory_ledger g
      LEFT JOIN inventory_balances b ON b.product_id = g.product_id AND b.location_id = g.location_id
     WHERE b.product_id IS NULL`);
  record(
    'every ledger row has a balance',
    orphans.rowCount === 0 ? 'PASS' : 'FAIL',
    `${orphans.rowCount} product × location pairs have ledger rows but no balance`,
    orphans.rows,
  );

  // 2. No negative stock.
  const negative = await client.query(`
    SELECT product_id::text AS product, location_id::text AS location, on_hand, reserved
      FROM inventory_balances WHERE on_hand < 0 OR reserved < 0 OR reserved > on_hand`);
  record(
    'no negative stock',
    negative.rowCount === 0 ? 'PASS' : 'FAIL',
    `${negative.rowCount} balances are negative or reserve more than is on hand`,
    negative.rows,
  );

  // 3. Outbox.
  const outbox = (
    await client.query(`
      SELECT count(*)::int AS events,
             count(*) FILTER (WHERE (status = 'PROCESSED') <> (processed_at IS NOT NULL))::int AS inconsistent,
             count(*) FILTER (WHERE status = 'PENDING' AND created_at < now() - interval '1 hour')::int AS stuck,
             count(*) FILTER (WHERE status = 'DEAD')::int AS dead
        FROM outbox_events`)
  ).rows[0];
  record(
    'outbox: processed ⇔ processed_at',
    outbox.inconsistent === 0 ? 'PASS' : 'FAIL',
    `${outbox.events} events; ${outbox.inconsistent} with a status that disagrees with processed_at`,
  );
  const receipts = await client.query(`
    SELECT p.consumer, p.event_id::text AS event
      FROM processed_events p LEFT JOIN outbox_events e ON e.id = p.event_id
     WHERE e.id IS NULL`);
  record(
    'outbox: consumer receipts point at events',
    receipts.rowCount === 0 ? 'PASS' : 'FAIL',
    `${receipts.rowCount} consumer receipts for events that do not exist`,
    receipts.rows,
  );
  record(
    'outbox: nothing stuck',
    outbox.stuck === 0 && outbox.dead === 0 ? 'PASS' : 'WARN',
    `${outbox.stuck} events pending for more than an hour, ${outbox.dead} dead (the worker retries; a dead event needs a person)`,
  );

  // 4. Migrations.
  const dir = join(here, '..', 'migrations');
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((name) => [
      name,
      createHash('sha256')
        .update(readFileSync(join(dir, name), 'utf8'))
        .digest('hex'),
    ]);
  const applied = new Map(
    (await client.query('SELECT name, checksum FROM schema_migrations')).rows.map((r) => [
      r.name,
      r.checksum,
    ]),
  );
  const missing = files.filter(([n]) => !applied.has(n)).map(([n]) => n);
  const edited = files.filter(([n, c]) => applied.has(n) && applied.get(n) !== c).map(([n]) => n);
  const unknown = [...applied.keys()].filter((n) => !files.some(([f]) => f === n));
  const ok = missing.length === 0 && edited.length === 0 && unknown.length === 0;
  record(
    'migrations match the files',
    ok ? 'PASS' : 'FAIL',
    `${applied.size} applied of ${files.length} files; ${missing.length} not applied, ${edited.length} changed, ${unknown.length} unknown`,
    [
      ...missing.map((n) => `not applied: ${n}`),
      ...edited.map((n) => `changed: ${n}`),
      ...unknown.map((n) => `unknown: ${n}`),
    ],
  );

  // Row counts (for comparing a restore with its backup manifest).
  const counts = (
    await client.query(`
      SELECT (SELECT count(*) FROM inventory_ledger)::int AS inventory_ledger,
             (SELECT count(*) FROM inventory_balances)::int AS inventory_balances,
             (SELECT count(*) FROM outbox_events)::int AS outbox_events,
             (SELECT count(*) FROM stock_transfers)::int AS stock_transfers,
             (SELECT count(*) FROM purchase_orders)::int AS purchase_orders,
             (SELECT count(*) FROM replenishment_recommendations)::int AS replenishment_recommendations,
             (SELECT count(*) FROM forecast.demand_daily)::int AS demand_daily,
             (SELECT count(*) FROM forecast.runs)::int AS forecast_runs,
             (SELECT count(*) FROM report_runs)::int AS report_runs,
             (SELECT count(*) FROM users)::int AS users`)
  ).rows[0];
  await client.query('COMMIT');

  const failed = results.filter((r) => r.status === 'FAIL').length;
  if (args.json) {
    console.log(JSON.stringify({ database, ok: failed === 0, results, counts }, null, 2));
  } else {
    console.log(`Integrity check of database "${database}" (read-only)\n`);
    for (const r of results) {
      console.log(`  ${r.status.padEnd(4)}  ${r.name} — ${r.detail}`);
      for (const e of r.examples)
        console.log(`          e.g. ${typeof e === 'string' ? e : JSON.stringify(e)}`);
    }
    console.log(
      `\n  rows: ${Object.entries(counts)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ')}`,
    );
    console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) FAILED.`);
  }
  process.exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  console.error(`Integrity check could not run: ${err.message}`);
  process.exitCode = 2;
} finally {
  await client.end();
}
