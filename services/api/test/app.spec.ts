import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { loadEnv } from '../src/core/config/env';
import { DatabaseService } from '../src/core/database/database.service';

const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://u:p@localhost:1/none' });

async function buildApp(ping: () => Promise<number>): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] })
    .overrideProvider(DatabaseService)
    .useValue({ ping, onModuleDestroy: async () => undefined })
    .compile();
  const app = configureApp(moduleRef.createNestApplication({ logger: false }));
  await app.init();
  return app;
}

describe('API foundation', () => {
  let app: INestApplication;
  afterEach(async () => app?.close());

  it('GET /api/v1/health reports ok when the database answers', async () => {
    app = await buildApp(async () => 3);
    const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      service: 'retailpulse-api',
      checks: { database: { status: 'up', latencyMs: 3 } },
    });
  });

  it('GET /api/v1/health returns 503 when the database is down', async () => {
    app = await buildApp(async () => {
      throw new Error('ECONNREFUSED');
    });
    const res = await request(app.getHttpServer()).get('/api/v1/health').expect(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks.database).toEqual({ status: 'down' });
  });

  it('returns the standard error shape and echoes a valid correlation ID', async () => {
    app = await buildApp(async () => 1);
    const res = await request(app.getHttpServer())
      .get('/api/v1/does-not-exist')
      .set('x-correlation-id', 'test-corr-123')
      .expect(404);
    expect(res.headers['x-correlation-id']).toBe('test-corr-123');
    expect(res.body).toEqual({
      error: { code: 'NOT_FOUND', message: expect.any(String) },
      correlationId: 'test-corr-123',
    });
  });

  it('replaces a malformed correlation ID with a generated UUID', async () => {
    app = await buildApp(async () => 1);
    const res = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('x-correlation-id', 'bad id with spaces');
    expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

// Validation runs before any service/database call, so a mocked DB is enough here.
describe('request validation (400 VALIDATION_FAILED)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await buildApp(async () => 1);
  });
  afterAll(async () => app.close());

  it.each([
    ['/api/v1/products?pageSize=500', 'pageSize'],
    ['/api/v1/products?page=0', 'page'],
    ['/api/v1/products?sort=price:sideways', 'sort'],
    ['/api/v1/products?categoryId=abc', 'categoryId'],
    ['/api/v1/products/not-a-uuid', 'id'],
    ['/api/v1/products/not-a-uuid/stock', 'id'],
    ['/api/v1/products/not-a-uuid/ledger', 'id'],
    ['/api/v1/locations?type=WAREHOUSE', 'type'],
    ['/api/v1/locations/123/stock', 'id'],
  ])('GET %s → 400 on %s', async (url, field) => {
    const res = await request(app.getHttpServer()).get(url).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: field })]),
    );
    expect(res.body.correlationId).toEqual(expect.any(String));
  });
});

describe('loadEnv', () => {
  it('rejects a missing DATABASE_URL without echoing values', () => {
    expect(() => loadEnv({ API_PORT: '3000' })).toThrow(/DATABASE_URL/);
  });

  it('applies defaults', () => {
    expect(loadEnv({ DATABASE_URL: 'postgresql://u:p@h:5432/db' })).toMatchObject({
      API_PORT: 3000,
      NODE_ENV: 'development',
    });
  });
});
