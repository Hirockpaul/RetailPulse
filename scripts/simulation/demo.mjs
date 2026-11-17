// One-command demo for RetailPulse against a RUNNING API. ALL DATA IS SYNTHETIC.
//
// `npm run demo` first migrates and seeds the database (both safe to re-run), then this script:
//   1. signs in as the synthetic inventory manager,
//   2. sends simulated POS sales (scripts/simulation/pos-sim.mjs) — stock falls, alerts appear,
//   3. re-scans alerts once (the seed's opening stock did not go through events),
//   4. if the forecasting service is running: runs a forecast, waits for it, and generates
//      replenishment recommendations (nothing is ordered — a manager approves in the UI).
// Every step goes through the public API, exactly as a user would. Nothing edits the database.
//
// Usage: npm run demo -- [--api=http://localhost:3000] [--sales=200]
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rootEnv = resolve(here, '../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => a.slice(2).split('=')),
);
const BASE = (args.api ?? 'http://localhost:3000').replace(/\/$/, '');
const API = `${BASE}/api/v1`;
const SALES = args.sales ?? '200';
const EMAIL = 'inventory@retailpulse.test';

const step = (n, text) => console.log(`\n[${n}/4] ${text}`);
const fail = (text) => {
  console.error(`\n✗ ${text}`);
  process.exit(1);
};

let cookie = '';
async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

// ------------------------------------------------------------------ 1. sign in
step(1, `Signing in as ${EMAIL} at ${API} …`);
try {
  await fetch(`${API}/health`);
} catch {
  fail(`Cannot reach the API at ${API}. Start it first: npm run dev:api (or the compose demo).`);
}
if (!process.env.DEMO_PASSWORD) fail('DEMO_PASSWORD is not set (see .env.example).');
const login = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: process.env.DEMO_PASSWORD }),
});
if (!login.ok)
  fail(`Login failed (${login.status}). Was the database seeded with this DEMO_PASSWORD?`);
cookie = login.headers.getSetCookie()[0].split(';')[0];
console.log('  signed in.');

// ------------------------------------------------------------------ 2. POS traffic
step(2, `Sending ${SALES} simulated POS sales …`);
const sim = spawnSync(
  process.execPath,
  [resolve(here, 'pos-sim.mjs'), `--sales=${SALES}`, '--concurrency=4', `--api=${BASE}`],
  { stdio: 'inherit' },
);
if (sim.status !== 0) fail('The POS simulator reported errors (see above).');

// ------------------------------------------------------------------ 3. alerts
step(3, 'Re-scanning stock alerts …');
const rescan = await call('POST', '/alerts/rescan');
if (rescan.status !== 200 && rescan.status !== 201) fail(`Re-scan failed (${rescan.status}).`);
console.log(`  checked ${rescan.body.evaluated} stock positions.`);

// ------------------------------------------------------------------ 4. forecast + recommendations
step(4, 'Forecast and replenishment recommendations …');
const started = await call('POST', '/forecasts/run', {});
if (started.status === 503) {
  console.log('  forecasting service is not running — skipped. To include it:');
  console.log('    npm run forecast:history   (once: synthetic sales history)');
  console.log('    npm run forecast:serve     (then run npm run demo again)');
} else {
  if (started.status !== 202 && started.body.error?.code !== 'FORECAST_RUN_IN_PROGRESS') {
    fail(`Could not start a forecast (${started.status} ${started.body.error?.code ?? ''}).`);
  }
  const deadline = Date.now() + 5 * 60_000;
  let latest;
  for (;;) {
    latest = (await call('GET', '/forecasts/runs/latest')).body.latest;
    if (latest && latest.status !== 'RUNNING') break;
    if (Date.now() > deadline) fail('The forecast run did not finish within 5 minutes.');
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log();
  if (latest.status !== 'SUCCEEDED') fail(`Forecast run ${latest.status}: ${latest.error ?? ''}`);
  console.log(`  forecast done: model ${latest.servedModel} (${latest.dataLabel} data).`);
  const generated = await call('POST', '/replenishment/generate');
  if (generated.status !== 200) fail(`Generating recommendations failed (${generated.status}).`);
  const g = generated.body;
  console.log(
    `  ${g.created} recommendations (${g.byRisk.CRITICAL} critical): ` +
      `${g.byAction.TRANSFER} transfers, ${g.byAction.PURCHASE_ORDER} purchase orders — ` +
      'waiting for a manager to approve.',
  );
}

console.log('\n✓ Demo data ready (synthetic). Open the web app and start at Overview.');
