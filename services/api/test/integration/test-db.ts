import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import pg from 'pg';
import { loadEnv } from '../../src/core/config/env';

const scripts = resolve(__dirname, '../../scripts');
const STALE_AFTER_MS = 60 * 60 * 1000;

/** The database created for this test file (dropped again by releaseTestDatabase()). */
let created: { adminUrl: string; name: string } | undefined;

/**
 * Integration tests never touch the dev database, and never share a database with each other.
 * Every test file gets its own throw-away database `<dev db>_t<time>_<random>`: created,
 * migrated, seeded with synthetic data — and dropped in releaseTestDatabase() (call it last in
 * afterAll). Two test runs at the same time (yours, CI, an editor, …) therefore cannot reset
 * each other's data.
 *
 * Set TEST_DATABASE_URL to use one fixed database instead (it is then never dropped).
 */
export async function prepareTestDatabase(): Promise<string> {
  const devUrl = loadEnv().DATABASE_URL;
  process.env.DEMO_PASSWORD ??= 'ci-demo-password-1'; // demo accounts are seeded with this

  let testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) {
    const base = new URL(devUrl).pathname.slice(1);
    const name = `${base}_t${Date.now()}_${randomBytes(3).toString('hex')}`;
    if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Unsafe test database name: ${name}`);

    const admin = new pg.Client({ connectionString: devUrl });
    await admin.connect();
    try {
      await dropStale(admin, base);
      await admin.query(`CREATE DATABASE "${name}"`);
    } finally {
      await admin.end();
    }
    created = { adminUrl: devUrl, name };
    const url = new URL(devUrl);
    url.pathname = `/${name}`;
    testUrl = url.toString();
  }

  const env = { ...process.env, DATABASE_URL: testUrl, NODE_ENV: 'test' };
  execFileSync(process.execPath, [resolve(scripts, 'migrate.mjs')], { env, stdio: 'pipe' });
  execFileSync(process.execPath, [resolve(scripts, 'seed.mjs'), '--reset'], { env, stdio: 'pipe' });
  return testUrl;
}

/** Drop this file's database. Call after the app and every client are closed. */
export async function releaseTestDatabase(): Promise<void> {
  if (!created) return;
  const { adminUrl, name } = created;
  created = undefined;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

/** Remove leftovers of killed runs: our own naming scheme and older than an hour. */
async function dropStale(admin: pg.Client, base: string) {
  const { rows } = await admin.query<{ datname: string }>(
    'SELECT datname FROM pg_database WHERE datname LIKE $1',
    [`${base.replace(/[\\%_]/g, (c) => `\\${c}`)}\\_t%`],
  );
  for (const { datname } of rows) {
    const stamp = new RegExp(`^${base}_t(\\d{13})_[0-9a-f]{6}$`).exec(datname)?.[1];
    if (stamp && Date.now() - Number(stamp) > STALE_AFTER_MS) {
      await admin.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
    }
  }
}
