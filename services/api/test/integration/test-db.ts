import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import pg from 'pg';
import { loadEnv } from '../../src/core/config/env';

const scripts = resolve(__dirname, '../../scripts');

/**
 * Integration tests never touch the dev database. They use `<dev db name>_test`
 * (or TEST_DATABASE_URL), created on demand, migrated, and re-seeded with synthetic data.
 */
export async function prepareTestDatabase(): Promise<string> {
  const devUrl = loadEnv().DATABASE_URL;
  const testUrl = process.env.TEST_DATABASE_URL ?? deriveTestUrl(devUrl);
  const dbName = new URL(testUrl).pathname.slice(1);
  if (!/^[A-Za-z0-9_]+$/.test(dbName)) throw new Error(`Unsafe test database name: ${dbName}`);

  const admin = new pg.Client({ connectionString: devUrl });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      dbName,
    ]);
    if (rowCount === 0) await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }

  const env = { ...process.env, DATABASE_URL: testUrl, NODE_ENV: 'test' };
  execFileSync(process.execPath, [resolve(scripts, 'migrate.mjs')], { env, stdio: 'pipe' });
  execFileSync(process.execPath, [resolve(scripts, 'seed.mjs'), '--reset'], { env, stdio: 'pipe' });
  return testUrl;
}

function deriveTestUrl(devUrl: string): string {
  const url = new URL(devUrl);
  url.pathname = `${url.pathname.slice(1)}_test`;
  return url.toString();
}
