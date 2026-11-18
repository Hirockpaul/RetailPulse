/** V2 3a: manager-controlled model activation and rollback against real PostgreSQL constraints. */
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
let db: pg.Client;
const cookies = {} as Record<keyof typeof DEMO, string>;
const models = {} as Record<'old' | 'candidate' | 'rejected' | 'withoutArtifact', string>;

const get = (who: keyof typeof DEMO) =>
  request(app.getHttpServer()).get('/api/v1/ml/models').set('Cookie', cookies[who]);
const decide = (
  who: keyof typeof DEMO,
  id: string,
  action: 'activate' | 'rollback',
  reason = 'Measured improvement approved for the next forecast run',
) =>
  request(app.getHttpServer())
    .post(`/api/v1/ml/models/${id}/${action}`)
    .set('Cookie', cookies[who])
    .send({ reason });

beforeAll(async () => {
  url = await prepareTestDatabase();
  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: url, FORECAST_URL: 'http://127.0.0.1:1' });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).compile();
  app = configureApp(moduleRef.createNestApplication({ logger: false }));
  await app.init();
  db = new pg.Client({ connectionString: url });
  await db.connect();
  for (const who of Object.keys(DEMO) as (keyof typeof DEMO)[])
    cookies[who] = await login(app, DEMO[who]);

  for (const [key, name, version, kind, status] of [
    ['old', 'hgb_direct', '2', 'ML', 'ACTIVE'],
    ['candidate', 'moving_average_28', '1', 'BASELINE', 'ELIGIBLE'],
    ['rejected', 'seasonal_naive_7', '1', 'BASELINE', 'REJECTED'],
  ] as const) {
    models[key] = (
      await db.query(
        `INSERT INTO forecast.model_versions
           (name, version, kind, description, status, eligibility_reason, artifact_path,
            artifact_sha256, artifact_schema_version, artifact_created_at)
         VALUES ($1, $2, $3, 'test model', $4, 'test gate result', $5, $6, 1, now()) RETURNING id`,
        [
          name,
          version,
          kind,
          status,
          `${name}/${version}/${key}.joblib`,
          ({ old: 'a', candidate: 'b', rejected: 'c' } as const)[key].repeat(64),
        ],
      )
    ).rows[0].id as string;
  }
  await db.query(
    `INSERT INTO forecast.model_versions
       (name, version, kind, description, status, eligibility_reason)
     VALUES ('category_average', '1', 'FALLBACK', 'test fallback', 'REJECTED', 'not activatable')`,
  );
  models.withoutArtifact = (
    await db.query(
      `INSERT INTO forecast.model_versions
         (name, version, kind, description, status, eligibility_reason)
       VALUES ('unmaterialized_test', '1', 'BASELINE', 'test model', 'ELIGIBLE', 'test gate result')
       RETURNING id`,
    )
  ).rows[0].id as string;
  await db.query(
    `INSERT INTO forecast.model_activations (action, to_model_id, reason)
     VALUES ('BOOTSTRAP', $1, 'First successful run bootstrap')`,
    [models.old],
  );
});

afterAll(async () => {
  await db?.end();
  await app?.close();
  await releaseTestDatabase();
});

async function operationalCounts() {
  const { rows } = await db.query(
    `SELECT (SELECT count(*) FROM inventory_ledger)::int ledger,
            (SELECT count(*) FROM inventory_balances)::int balances,
            (SELECT count(*) FROM stock_transfers)::int transfers,
            (SELECT count(*) FROM purchase_orders)::int orders,
            (SELECT count(*) FROM replenishment_recommendations)::int recommendations,
            (SELECT count(*) FROM outbox_events)::int events`,
  );
  return rows[0];
}

describe('model registry', () => {
  it('is readable by every signed-in role and validates/authorizes decisions', async () => {
    const list = (await get('analyst').expect(200)).body;
    expect(list.activationWapeGain).toBe(0.005);
    expect(list.models).toHaveLength(5);
    expect(list.models.find((m: { status: string }) => m.status === 'ACTIVE')).toMatchObject({
      name: 'hgb_direct',
      artifactPath: 'hgb_direct/2/old.joblib',
      artifactSchemaVersion: 1,
    });
    await decide('analyst', models.candidate, 'activate').expect(403);
    await decide('inventory', models.candidate, 'activate', 'bad').expect(400);
    await decide('inventory', models.rejected, 'activate').expect(409);
    await decide('inventory', models.withoutArtifact, 'activate').expect(409);
    await decide('inventory', 'not-a-uuid', 'activate').expect(400);
  });

  it('serializes five activations into one audited change and touches no operational data', async () => {
    const before = await operationalCounts();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => decide('inventory', models.candidate, 'activate')),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);
    expect(await operationalCounts()).toEqual(before);
    const active = await db.query(`SELECT id FROM forecast.model_versions WHERE status = 'ACTIVE'`);
    expect(active.rows).toEqual([{ id: models.candidate }]);
    const history = (await get('admin').expect(200)).body.history;
    expect(history[0]).toMatchObject({
      action: 'ACTIVATE',
      fromModelId: models.old,
      toModelId: models.candidate,
      actorName: 'Imani Inventory',
    });
  });

  it('rolls back only to the immediately previous active model and history is immutable', async () => {
    await decide('admin', models.rejected, 'rollback').expect(409);
    const body = (
      await decide('admin', models.old, 'rollback', 'Rollback after manager review').expect(201)
    ).body;
    expect(body.models.find((m: { status: string }) => m.status === 'ACTIVE')).toMatchObject({
      id: models.old,
      name: 'hgb_direct',
      artifactSha256: 'a'.repeat(64),
    });
    expect(body.history[0]).toMatchObject({
      action: 'ROLLBACK',
      fromModelId: models.candidate,
      toModelId: models.old,
      actorName: 'Avery Admin',
    });
    const id = body.history[0].id as string;
    await expect(
      db.query(`UPDATE forecast.model_activations SET reason = 'rewritten' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      db.query(`UPDATE forecast.model_versions SET artifact_sha256 = $2 WHERE id = $1`, [
        models.old,
        'f'.repeat(64),
      ]),
    ).rejects.toMatchObject({ code: '23001' });
  });
});
