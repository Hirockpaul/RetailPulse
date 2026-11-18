/**
 * V2 3c-2: model monitoring API and live run-health checks against a real PostgreSQL.
 * A tiny fake forecasting service answers POST /monitoring/run (it writes one monitoring row,
 * as the real service does); a second app points at nothing to prove the 503.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { loadEnv } from '../../src/core/config/env';
import { DEMO, login } from './auth-helpers';
import { prepareTestDatabase, releaseTestDatabase } from './test-db';

let url: string;
let app: INestApplication;
let down: INestApplication;
let fake: Server;
let fakeMode: 'ok' | 'error' = 'ok';
let db: pg.Client;
const cookies = {} as Record<keyof typeof DEMO, string>;
const downCookies = {} as Record<'inventory', string>;

type Check = { key: string; level: string; message: string };

const overview = async (who: keyof typeof DEMO = 'analyst') =>
  (await request(app.getHttpServer()).get('/api/v1/ml/monitoring').set('Cookie', cookies[who]))
    .body as {
    health: { overall: string; checks: Check[] };
    latest: (Record<string, unknown> & { results: Record<string, unknown>[] }) | null;
    recent: Record<string, unknown>[];
    rules: { text: string[] };
  };
const level = (o: Awaited<ReturnType<typeof overview>>, key: string) =>
  o.health.checks.find((c) => c.key === key)!;

async function buildApp(forecastUrl: string): Promise<INestApplication> {
  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: url, FORECAST_URL: forecastUrl });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).compile();
  const a = configureApp(moduleRef.createNestApplication({ logger: false }));
  await a.init();
  return a;
}

async function forecastRun(status: 'SUCCEEDED' | 'FAILED', daysBack: number, minutesAgo: number) {
  return (
    await db.query(
      `INSERT INTO forecast.runs (status, started_at, finished_at, horizon_days, history_end, error)
       VALUES ($1, now() - make_interval(mins => $3), now() - make_interval(mins => $3 - 1), 14,
               current_date - $2::int, $4)
       RETURNING id`,
      [status, daysBack, minutesAgo, status === 'FAILED' ? 'ValueError: no history' : null],
    )
  ).rows[0].id as string;
}

async function monitoringRun(
  forecastRunId: string | null,
  statuses: [string, string, string] = [
    'INSUFFICIENT_DATA',
    'INSUFFICIENT_DATA',
    'INSUFFICIENT_DATA',
  ],
  currentDays = 0,
) {
  const id = (
    await db.query(
      `INSERT INTO forecast.monitoring_runs
         (created_at, trigger, forecast_run_id, model_name, training_end, latest_data_day,
          reference_start, reference_end, current_days, status, data_drift_status,
          prediction_drift_status, performance_status)
       VALUES (COALESCE((SELECT finished_at + interval '30 seconds' FROM forecast.runs
                          WHERE id = $2::uuid), now()),
               $1, $2, 'hgb_direct', current_date - 1, current_date - 1, current_date - 28,
               current_date - 1, $3, 'SUCCEEDED', $4, $5, $6)
       RETURNING id`,
      [forecastRunId ? 'FORECAST_RUN' : 'MANUAL', forecastRunId, currentDays, ...statuses],
    )
  ).rows[0].id as string;
  await db.query(
    `INSERT INTO forecast.monitoring_results (run_id, check_kind, subject, n_reference, n_current,
        psi, ks_d, ks_p, status)
     VALUES ($1, 'FEATURE', 'mean_7d', 27125, 0, NULL, NULL, NULL, 'INSUFFICIENT_DATA'),
            ($1, 'STORE_SALES', 'STR-01', 5600, 0, NULL, NULL, NULL, 'INSUFFICIENT_DATA')`,
    [id],
  );
  return id;
}

const tableCounts = async () =>
  (
    await db.query(
      `SELECT (SELECT count(*) FROM forecast.runs)::int AS runs,
              (SELECT count(*) FROM forecast.monitoring_runs)::int AS monitoring,
              (SELECT count(*) FROM forecast.monitoring_results)::int AS results,
              (SELECT count(*) FROM forecast.model_versions)::int AS models,
              (SELECT count(*) FROM inventory_ledger)::int AS ledger,
              (SELECT count(*) FROM outbox_events)::int AS outbox`,
    )
  ).rows[0];

beforeAll(async () => {
  url = await prepareTestDatabase();
  db = new pg.Client({ connectionString: url });
  await db.connect();
  fake = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/monitoring/run') {
      res.writeHead(404).end();
      return;
    }
    if (fakeMode === 'error') {
      res.writeHead(500).end();
      return;
    }
    void monitoringRun(null, ['STABLE', 'WATCH', 'OK'], 9).then((id) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ monitoringRunId: id, status: 'SUCCEEDED', error: null }));
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const port = (fake.address() as AddressInfo).port;
  app = await buildApp(`http://127.0.0.1:${port}`);
  down = await buildApp('http://127.0.0.1:1');
  for (const who of Object.keys(DEMO) as (keyof typeof DEMO)[])
    cookies[who] = await login(app, DEMO[who]);
  downCookies.inventory = await login(down, DEMO.inventory);
});

afterAll(async () => {
  await db?.end();
  await app?.close();
  await down?.close();
  await new Promise((resolve) => fake?.close(resolve));
  await releaseTestDatabase();
});

describe('model monitoring and run health (V2 3c-2)', () => {
  it('with no runs at all: no forecast is an alert, monitoring has not run, nothing judged', async () => {
    const o = await overview();
    expect(o.latest).toBeNull();
    expect(o.recent).toEqual([]);
    expect(o.health.overall).toBe('ALERT');
    expect(level(o, 'FRESHNESS')).toMatchObject({ level: 'ALERT' });
    expect(level(o, 'LATEST_RUN')).toMatchObject({ level: 'ALERT' });
    expect(level(o, 'MONITORING')).toMatchObject({ level: 'WARN' });
    expect(level(o, 'MODEL_QUALITY').message).toContain('Not judged yet');
    expect(o.rules.text.join(' ')).toContain('never retrains');
  });

  it('a fresh successful run that was monitored, with too few new days, is OK but says so', async () => {
    const run = await forecastRun('SUCCEEDED', 1, 30); // data up to yesterday
    let o = await overview();
    expect(level(o, 'FRESHNESS').level).toBe('OK');
    expect(level(o, 'LATEST_RUN').level).toBe('OK');
    expect(level(o, 'MONITORING')).toMatchObject({
      level: 'WARN',
      message: 'Monitoring has not run yet.',
    });

    const m = await monitoringRun(run);
    o = await overview();
    expect(o.health.overall).toBe('OK');
    expect(level(o, 'MONITORING').level).toBe('OK');
    expect(level(o, 'MODEL_QUALITY')).toEqual({
      key: 'MODEL_QUALITY',
      level: 'OK',
      message: 'Not enough new days to judge yet (0 since training; 7 needed).',
    });
    expect(o.latest).toMatchObject({
      id: m,
      trigger: 'FORECAST_RUN',
      forecastRunId: run,
      currentDays: 0,
      dataDrift: 'INSUFFICIENT_DATA',
    });
    expect(o.latest!.results).toHaveLength(2);
    expect(o.latest!.results[0]).toMatchObject({ checkKind: 'FEATURE', nReference: 27125 });
  });

  it('a newer failed run is an alert with its error', async () => {
    await forecastRun('FAILED', 1, 10);
    const o = await overview();
    expect(level(o, 'LATEST_RUN')).toMatchObject({
      level: 'ALERT',
      message: 'The latest forecast run failed: ValueError: no history.',
    });
  });

  it('a stale latest success is an alert, and monitoring that missed it is a warning', async () => {
    await forecastRun('SUCCEEDED', 3, 5); // newest success, but data ends 3 days ago
    const o = await overview();
    expect(level(o, 'FRESHNESS')).toMatchObject({
      level: 'ALERT',
      message: 'The latest forecast is 2 days behind the latest complete day of sales.',
    });
    expect(level(o, 'MONITORING')).toMatchObject({
      level: 'WARN',
      message: 'The latest successful forecast run has not been monitored yet.',
    });
  });

  it('drift or degraded accuracy in the latest monitoring is an alert naming the problem', async () => {
    const run = await forecastRun('SUCCEEDED', 1, 2);
    await monitoringRun(run, ['DRIFT', 'STABLE', 'DEGRADED'], 12);
    const o = await overview();
    expect(level(o, 'MODEL_QUALITY')).toMatchObject({
      level: 'ALERT',
      message: 'The data has drifted; accuracy on new days is degraded.',
    });
    expect(level(o, 'FRESHNESS').level).toBe('OK');
  });

  it('reading writes nothing; everyone signed in may read, only approvers may run', async () => {
    const before = await tableCounts();
    for (const who of ['admin', 'inventory', 'store1', 'store2', 'analyst'] as const) {
      await request(app.getHttpServer())
        .get('/api/v1/ml/monitoring')
        .set('Cookie', cookies[who])
        .expect(200);
    }
    expect(await tableCounts()).toEqual(before);
    await request(app.getHttpServer()).get('/api/v1/ml/monitoring').expect(401);
    for (const who of ['store1', 'analyst'] as const) {
      await request(app.getHttpServer())
        .post('/api/v1/ml/monitoring/run')
        .set('Cookie', cookies[who])
        .expect(403);
    }
    expect(await tableCounts()).toEqual(before);
  });

  it('running now asks the service and returns the fresh result; service errors are explicit', async () => {
    const before = await tableCounts();
    fakeMode = 'ok';
    const res = await request(app.getHttpServer())
      .post('/api/v1/ml/monitoring/run')
      .set('Cookie', cookies.inventory)
      .expect(200);
    expect(res.body.latest).toMatchObject({
      trigger: 'MANUAL',
      dataDrift: 'STABLE',
      predictionDrift: 'WATCH',
      performance: 'OK',
      currentDays: 9,
    });
    expect(res.body.health.checks.find((c: Check) => c.key === 'MODEL_QUALITY').level).toBe('WARN');
    const after = await tableCounts();
    expect(after).toEqual({
      ...before,
      monitoring: before.monitoring + 1,
      results: before.results + 2,
    });

    fakeMode = 'error';
    const failed = await request(app.getHttpServer())
      .post('/api/v1/ml/monitoring/run')
      .set('Cookie', cookies.admin)
      .expect(502);
    expect(failed.body.error.code).toBe('FORECAST_SERVICE_ERROR');

    const unavailable = await request(down.getHttpServer())
      .post('/api/v1/ml/monitoring/run')
      .set('Cookie', downCookies.inventory)
      .expect(503);
    expect(unavailable.body.error.code).toBe('FORECAST_SERVICE_UNAVAILABLE');
  });
});
