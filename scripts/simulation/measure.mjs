// Measures a RUNNING API as a signed-in user would see it (synthetic data). Local numbers from YOUR
// machine, not a benchmark claim. Targets: docs/V2-PLAN.md step 5d (fixed before measuring).
//
//   npm run measure                 reads: 200 sequential requests per endpoint (after 10 warm-ups)
//   npm run measure -- --ops        heavy operations, 5 runs each (they write what a user would:
//                                   recommendation generation replaces pending ones, scenario
//                                   results and reports are added)
//   npm run measure -- --load       20 concurrent readers for 30 s over a mix of read paths
// Options: --api=http://localhost:3000  --n=200  --runs=5  --clients=20  --seconds=30
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootEnv = resolve(dirname(fileURLToPath(import.meta.url)), '../../.env');
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
const call = async (method, path, body) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  const type = res.headers.get('content-type') ?? '';
  return type.includes('json') ? res.json() : res.text();
};
const get = (path) => call('GET', path);
const post = (path, body = {}) => call('POST', path, body);

const pct = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const f = (x) => x.toFixed(1).padStart(8);
const label = (path) => path.replace(/[0-9a-f-]{36}/g, ':id');

// ---------------------------------------------------------------- what to read
const store = (await get('/locations?type=STORE')).data[0];
const product = (await get('/products?pageSize=1')).data[0];
const supplier = (await get('/suppliers/performance'))[0];
const report = (await get('/reports?pageSize=1')).data[0];
const pair = `productId=${product.id}&locationId=${store.id}`;

/** [path, target p95 ms]: 100 for simple reads, 300 for aggregate read models (step 5d). */
const READS = [
  ['/products?q=milk&pageSize=25', 100],
  [`/products/${product.id}/stock`, 100],
  [`/products/${product.id}/ledger?pageSize=25`, 100],
  [`/locations/${store.id}/stock?pageSize=25`, 100],
  ['/replenishment/recommendations?status=PENDING&pageSize=25', 100],
  ['/alerts?pageSize=25', 100],
  ['/overview', 300],
  ['/overview/locations', 300],
  [`/replenishment/status?productId=${product.id}`, 300],
  ['/forecasts/runs/latest', 100],
  [`/forecasts/series?${pair}`, 300],
  [`/forecasts/explanation?${pair}`, 100],
  ['/classifications?pageSize=25', 100],
  ['/classifications/summary', 100],
  ['/suppliers/performance', 100],
  ...(supplier ? [[`/suppliers/${supplier.id}/performance`, 100]] : []),
  ['/anomalies?status=OPEN&pageSize=25', 100],
  ['/ml/models', 100],
  ['/ml/monitoring', 300],
  ['/scenarios', 100],
  ['/reports?pageSize=20', 100],
  ...(report ? [[`/reports/${report.id}`, 100]] : []),
  ['/openapi.json', 100],
];

async function measureReads() {
  console.log(`${N} sequential requests per endpoint against ${API} (after 10 warm-up requests)\n`);
  console.log(
    'endpoint'.padEnd(64),
    'p50 ms'.padStart(8),
    'p95 ms'.padStart(8),
    'max ms'.padStart(8),
    'target'.padStart(8),
  );
  let failed = 0;
  for (const [path, target] of READS) {
    for (let i = 0; i < 10; i++) await get(path);
    const times = [];
    for (let i = 0; i < N; i++) {
      const start = performance.now();
      await get(path);
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const p95 = pct(times, 95);
    const ok = p95 <= target;
    if (!ok) failed++;
    console.log(
      label(path).padEnd(64),
      f(pct(times, 50)),
      f(p95),
      f(times.at(-1)),
      `${ok ? '  ' : '✗ '}≤${target}`.padStart(8),
    );
  }
  console.log(failed === 0 ? '\nAll reads within target.' : `\n${failed} read(s) over target.`);
}

// ---------------------------------------------------------------- heavy operations
async function measureOps() {
  const runs = Number(args.runs ?? 5);
  const name = 'measure: demand +20 %';
  let scenario = (await get('/scenarios')).find((s) => s.name === name);
  if (!scenario) {
    scenario = await post('/scenarios', {
      name,
      description: 'Created by npm run measure -- --ops',
      demandPct: 20,
      supplierLeadTimeDays: 0,
      dcAvailabilityPct: 0,
    });
  }
  const OPS = [
    ['generate recommendations', () => post('/replenishment/generate'), 5000],
    ['run a scenario', () => post(`/scenarios/${scenario.id}/run`), 2000],
    ['generate a network daily report', () => post('/reports/generate', { kind: 'DAILY' }), 2000],
    ['recalculate ABC/XYZ', () => post('/classifications/recalculate'), 5000],
  ];
  console.log(`Operations, ${runs} runs each, against ${API}\n`);
  console.log(
    'operation'.padEnd(40),
    'median ms'.padStart(10),
    'max ms'.padStart(10),
    'target'.padStart(10),
  );
  let failed = 0;
  for (const [what, run, target] of OPS) {
    const times = [];
    for (let i = 0; i < runs; i++) {
      const start = performance.now();
      await run();
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    const ok = median <= target;
    if (!ok) failed++;
    console.log(
      what.padEnd(40),
      median.toFixed(0).padStart(10),
      times.at(-1).toFixed(0).padStart(10),
      `${ok ? '  ' : '✗ '}≤${target}`.padStart(10),
    );
  }
  console.log(
    failed === 0 ? '\nAll operations within target.' : `\n${failed} operation(s) over target.`,
  );
}

// ---------------------------------------------------------------- concurrent load
async function measureLoad() {
  const clients = Number(args.clients ?? 20);
  const seconds = Number(args.seconds ?? 30);
  const mix = READS.map(([path]) => path).filter((p) => p !== '/openapi.json');
  const times = [];
  const errors = [];
  const until = performance.now() + seconds * 1000;
  const worker = async (w) => {
    let i = w;
    while (performance.now() < until) {
      const path = mix[i++ % mix.length];
      const start = performance.now();
      try {
        await get(path);
        times.push(performance.now() - start);
      } catch (err) {
        errors.push(String(err.message ?? err).slice(0, 120));
      }
    }
  };
  console.log(`${clients} concurrent readers for ${seconds} s over ${mix.length} read paths…`);
  await Promise.all(Array.from({ length: clients }, (_, w) => worker(w)));
  times.sort((a, b) => a - b);
  const p95 = pct(times, 95);
  console.log(
    `\nrequests ${times.length + errors.length}, ${(times.length / seconds).toFixed(0)} req/s, ` +
      `p50 ${pct(times, 50).toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${times.at(-1).toFixed(1)} ms, ` +
      `errors ${errors.length}`,
  );
  if (errors.length) console.log('first errors:', [...new Set(errors)].slice(0, 3));
  console.log(
    errors.length === 0 && p95 <= 1000
      ? 'Within target (0 errors, p95 ≤ 1000 ms).'
      : 'Over target (errors or p95 > 1000 ms).',
  );
}

if (args.ops) await measureOps();
else if (args.load) await measureLoad();
else await measureReads();
