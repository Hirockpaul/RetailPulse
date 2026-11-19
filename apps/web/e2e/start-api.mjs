// Starts the API for the end-to-end test on its OWN database, so the test never touches your
// dev data: <dev db>_e2e is dropped, re-created, migrated and seeded with synthetic data, then
// the compiled API (services/api/dist) is started on E2E_API_PORT. Used by playwright.config.ts.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { seedForecastFixture } from './forecast-fixture.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const api = resolve(root, 'services/api');
if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));

const devUrl = process.env.DATABASE_URL;
if (!devUrl) throw new Error('DATABASE_URL is not set (copy .env.example to .env).');
if (!existsSync(resolve(api, 'dist/main.js'))) {
  throw new Error('The API is not built. Run: npm run build -w services/api');
}

const name = `${new URL(devUrl).pathname.slice(1)}_e2e`;
if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Unsafe database name: ${name}`);
const admin = new pg.Client({ connectionString: devUrl });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
await admin.query(`CREATE DATABASE "${name}"`);
await admin.end();

const url = new URL(devUrl);
url.pathname = `/${name}`;
const env = {
  ...process.env,
  DATABASE_URL: url.toString(),
  API_PORT: process.env.E2E_API_PORT ?? '3100',
  NODE_ENV: 'development',
  EVENT_WORKER_ENABLED: 'true',
  HOUSEKEEPING_ENABLED: 'false',
  FORECAST_URL: 'http://127.0.0.1:1', // no forecasting service in this test
};
execFileSync(process.execPath, [resolve(api, 'scripts/migrate.mjs')], { env, stdio: 'inherit' });
execFileSync(process.execPath, [resolve(api, 'scripts/seed.mjs')], { env, stdio: 'inherit' });
await seedForecastFixture(env.DATABASE_URL); // V2 6-1: a labelled fixture forecast for the browser flow

const child = spawn(process.execPath, ['dist/main.js'], { cwd: api, env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 0));
