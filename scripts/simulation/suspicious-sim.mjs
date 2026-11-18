// Simulated UNUSUAL stock activity for RetailPulse. ALL DATA IS SYNTHETIC.
//
// Creates, through the public API (exactly as a user would, with Idempotency-Key), the patterns
// the operational-anomaly rules look for (services/api/src/modules/anomalies/anomalies.config.ts):
//   * one large write-off (an adjustment removing most of a product's stock at a store),
//   * a burst of small stock-reducing adjustments of one product,
//   * many returns of one product against few sales.
// The event worker turns them into findings on the "Unusual activity" page within seconds.
// It never edits the database directly, and never takes stock below zero.
//
// Usage: npm run sim:suspicious -- [--api=http://localhost:3000] [--seed=1]
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
const API = (args.api ?? 'http://localhost:3000').replace(/\/$/, '') + '/api/v1';
let state = Number(args.seed ?? 1);
const rand = () => {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

let cookie = '';
async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID(), cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.error?.code ?? ''}`);
  return json;
}

if (!process.env.DEMO_PASSWORD) {
  console.error('DEMO_PASSWORD is not set (see .env.example).');
  process.exit(1);
}
try {
  const login = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'inventory@retailpulse.test',
      password: process.env.DEMO_PASSWORD,
    }),
  });
  if (!login.ok) throw new Error(`login → ${login.status}`);
  cookie = login.headers.getSetCookie()[0].split(';')[0];
} catch (err) {
  console.error(`API at ${API} failed (${err.message}). Is it running and seeded?`);
  process.exit(1);
}

const stores = (await call('GET', '/locations?type=STORE')).data;
const products = (await call('GET', '/products?pageSize=100')).data;
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const store = pick(stores);
const [a, b, c] = [...products].sort(() => rand() - 0.5).slice(0, 3);
const onHand = async (productId) =>
  (await call('GET', `/products/${productId}/stock`)).data.find((r) => r.locationId === store.id)
    ?.onHand ?? 0;

console.log(`Simulating unusual stock activity at ${store.code} (synthetic data) …`);

// 1. A large write-off: top the stock up, then remove most of it in one adjustment.
await call('POST', '/receipts', {
  locationId: store.id,
  lines: [{ productId: a.id, quantity: 40 }],
});
const removeA = Math.min(Math.floor((await onHand(a.id)) * 0.85), 60);
await call('POST', '/adjustments', {
  locationId: store.id,
  productId: a.id,
  delta: -removeA,
  reason: 'Simulated: stock count found far less than recorded',
});
console.log(`  ${a.sku}: one adjustment removed ${removeA} units`);

// 2. A burst of small stock-reducing corrections of one product.
await call('POST', '/receipts', {
  locationId: store.id,
  lines: [{ productId: b.id, quantity: 10 }],
});
for (let i = 0; i < 4; i++) {
  await call('POST', '/adjustments', {
    locationId: store.id,
    productId: b.id,
    delta: -1,
    reason: 'Simulated: unexplained shortfall',
  });
}
console.log(`  ${b.sku}: 4 small stock-reducing adjustments`);

// 3. Many returns against few sales.
await call('POST', '/receipts', {
  locationId: store.id,
  lines: [{ productId: c.id, quantity: 10 }],
});
await call('POST', '/sales', { locationId: store.id, lines: [{ productId: c.id, quantity: 2 }] });
for (let i = 0; i < 6; i++) {
  await call('POST', '/returns', {
    locationId: store.id,
    productId: c.id,
    quantity: 1,
    condition: i % 3 === 0 ? 'DAMAGED' : 'SELLABLE',
    reason: 'Simulated return',
  });
}
console.log(`  ${c.sku}: 6 returns after 1 sale`);
console.log('Done. Findings appear on "Unusual activity" once the event worker has run.');
