// Measures read latency of a RUNNING API, as a signed-in user would see it (synthetic data).
// Sends each request one after another (no concurrency) and prints p50 / p95 / max per endpoint.
// These are numbers from YOUR machine, not a benchmark claim.
//
// Usage: npm run measure -- [--api=http://localhost:3000] [--n=200]
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootEnv = resolve(dirname(fileURLToPath(import.meta.url)), '../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => a.slice(2).split('=')),
);
const API = (args.api ?? 'http://localhost:3000').replace(/\/$/, '') + '/api/v1';
const N = Number(args.n ?? 200);

const login = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: 'inventory@retailpulse.test',
    password: process.env.DEMO_PASSWORD,
  }),
});
if (!login.ok) throw new Error(`login failed: ${login.status} (is the API running and seeded?)`);
const cookie = login.headers.getSetCookie()[0].split(';')[0];
const get = async (path) => {
  const res = await fetch(`${API}${path}`, { headers: { cookie } });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json();
};

const store = (await get('/locations?type=STORE')).data[0];
const product = (await get('/products?pageSize=1')).data[0];
const endpoints = [
  '/products?q=milk&pageSize=25',
  `/products/${product.id}/stock`,
  `/products/${product.id}/ledger?pageSize=25`,
  `/locations/${store.id}/stock?pageSize=25`,
  '/replenishment/recommendations?status=PENDING&pageSize=25',
  '/alerts?pageSize=25',
  '/overview',
];

const pct = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
console.log(`${N} sequential requests per endpoint against ${API} (after 10 warm-up requests)\n`);
console.log(
  'endpoint'.padEnd(52),
  'p50 ms'.padStart(8),
  'p95 ms'.padStart(8),
  'max ms'.padStart(8),
);
for (const path of endpoints) {
  for (let i = 0; i < 10; i++) await get(path);
  const times = [];
  for (let i = 0; i < N; i++) {
    const start = performance.now();
    await get(path);
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const label = path.replace(/[0-9a-f-]{36}/g, ':id');
  const f = (x) => x.toFixed(1).padStart(8);
  console.log(label.padEnd(52), f(pct(times, 50)), f(pct(times, 95)), f(times.at(-1)));
}
