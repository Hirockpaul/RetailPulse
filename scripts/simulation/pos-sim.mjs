// Simulated point-of-sale traffic for RetailPulse. ALL TRAFFIC IS SYNTHETIC.
//
// Sends random multi-line sales to a running API through POST /api/v1/sales, exactly as a real
// POS would (with Idempotency-Key). Use it to see stock fall, stock-outs appear (409s), and to
// exercise concurrency. It never edits the database directly.
//
// It signs in like any user (default: the synthetic inventory manager, who may sell at every
// store) with the shared DEMO_PASSWORD from the repo-root .env.
//
// Usage: npm run sim:pos -- [--sales=50] [--concurrency=4] [--api=http://localhost:3000]
//                           [--seed=1] [--max-lines=3] [--max-qty=3]
//                           [--email=inventory@retailpulse.test]
import { randomUUID } from 'node:crypto';
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
const num = (name, fallback, min, max) => {
  const v = args[name] === undefined ? fallback : Number(args[name]);
  if (!Number.isInteger(v) || v < min || v > max) {
    console.error(`--${name} must be an integer between ${min} and ${max}.`);
    process.exit(1);
  }
  return v;
};
const SALES = num('sales', 50, 1, 10_000);
const CONCURRENCY = num('concurrency', 4, 1, 50);
const MAX_LINES = num('max-lines', 3, 1, 10);
const MAX_QTY = num('max-qty', 3, 1, 20);
let state = num('seed', 1, 0, 2 ** 31);
const API = (args.api ?? 'http://localhost:3000').replace(/\/$/, '') + '/api/v1';
const EMAIL = args.email ?? 'inventory@retailpulse.test';

// Deterministic RNG (mulberry32) so a run can be repeated with the same --seed.
function rand() {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (min, max) => min + Math.floor(rand() * (max - min + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

let cookie = '';

/** Sign in and keep the session cookie for every later request. */
async function signIn() {
  if (!process.env.DEMO_PASSWORD) {
    console.error('DEMO_PASSWORD is not set (see .env.example).');
    process.exit(1);
  }
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: process.env.DEMO_PASSWORD }),
  });
  if (!res.ok) throw new Error(`login as ${EMAIL} → ${res.status}`);
  cookie = res.headers.getSetCookie()[0].split(';')[0];
}

async function getAll(path) {
  const rows = [];
  for (let page = 1; ; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`${API}${path}${sep}page=${page}&pageSize=100`, {
      headers: { cookie },
    });
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
    const body = await res.json();
    rows.push(...body.data);
    if (rows.length >= body.total) return rows;
  }
}

let stores, products;
try {
  await signIn();
  stores = await getAll('/locations?type=STORE');
  products = await getAll('/products');
} catch (err) {
  console.error(`API at ${API} failed (${err.message}). Is "npm run dev:api" running and seeded?`);
  process.exit(1);
}
if (stores.length === 0 || products.length === 0) {
  console.error('No stores or products found. Run "npm run db:seed" first.');
  process.exit(1);
}

const tally = { created: 0, outOfStock: 0, other: 0, units: 0, revenueCents: 0 };
const otherErrors = new Map();

function makeSale() {
  const lineCount = Math.min(int(1, MAX_LINES), products.length);
  const chosen = new Set();
  while (chosen.size < lineCount) chosen.add(pick(products).id);
  return {
    locationId: pick(stores).id,
    lines: [...chosen].map((productId) => ({ productId, quantity: int(1, MAX_QTY) })),
  };
}

async function sendSale() {
  const body = makeSale();
  const res = await fetch(`${API}/sales`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID(), cookie },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 201) {
    tally.created++;
    tally.units += body.lines.reduce((n, l) => n + l.quantity, 0);
    tally.revenueCents += Math.round(Number(json.totalAmount) * 100);
  } else if (res.status === 409 && json.error?.code === 'INSUFFICIENT_STOCK') {
    tally.outOfStock++;
  } else {
    tally.other++;
    const label = `${res.status} ${json.error?.code ?? 'UNKNOWN'}`;
    otherErrors.set(label, (otherErrors.get(label) ?? 0) + 1);
  }
}

console.log(`Simulating ${SALES} synthetic sales (concurrency ${CONCURRENCY}) against ${API} …`);
const started = performance.now();
let next = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < SALES) {
      next++;
      await sendSale();
    }
  }),
);
const seconds = ((performance.now() - started) / 1000).toFixed(1);

console.log(`Done in ${seconds}s (synthetic data).`);
console.log(`  sales recorded:        ${tally.created}`);
console.log(`  rejected, no stock:    ${tally.outOfStock}   (expected when stores run low)`);
console.log(`  other errors:          ${tally.other}`);
for (const [label, n] of otherErrors) console.log(`    ${label}: ${n}`);
console.log(`  units sold:            ${tally.units}`);
console.log(`  revenue (synthetic):   ${(tally.revenueCents / 100).toFixed(2)}`);
if (tally.other > 0) process.exitCode = 1;
