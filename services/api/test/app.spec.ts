import { INestApplication } from '@nestjs/common';
import { DiscoveryModule, DiscoveryService, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import type { AuthUser } from '../src/core/auth/auth.types';
import { PUBLIC_KEY, ROLES_KEY } from '../src/core/auth/roles';
import { SessionService } from '../src/core/auth/session.service';
import { loadEnv } from '../src/core/config/env';
import { DatabaseService } from '../src/core/database/database.service';

const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://u:p@localhost:1/none' });

const ID = '00000000-0000-4000-8000-000000000000';
const user = (role: AuthUser['role'], locationIds: string[] = []): AuthUser => ({
  id: ID,
  email: `${role.toLowerCase()}@retailpulse.test`,
  displayName: role,
  role,
  locationIds,
});
const SESSIONS: Record<string, AuthUser> = {
  'tok-admin': user('ADMIN'),
  'tok-inventory': user('INVENTORY_MANAGER'),
  'tok-store': user('STORE_MANAGER', [ID]),
  'tok-analyst': user('ANALYST'),
};
const as = (token: string) => `rp_session=${token}`;

/** App with a mocked database and fake sessions: exercises routing, guards and validation only. */
async function buildApp(ping: () => Promise<number>): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot(env), DiscoveryModule],
  })
    .overrideProvider(DatabaseService)
    .useValue({ ping, onModuleDestroy: async () => undefined })
    .overrideProvider(SessionService)
    .useValue({ validate: async (token: string) => SESSIONS[token] ?? null })
    .compile();
  const app = configureApp(moduleRef.createNestApplication({ logger: false }));
  await app.init();
  return app;
}

describe('API foundation', () => {
  let app: INestApplication;
  afterEach(async () => app?.close());

  it('GET /api/v1/health is public and reports ok when the database answers', async () => {
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

describe('authentication and roles (global guard)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await buildApp(async () => 1);
  });
  afterAll(async () => app.close());
  const server = () => request(app.getHttpServer());

  it.each([
    ['GET', '/api/v1/products'],
    ['GET', '/api/v1/locations'],
    ['GET', '/api/v1/transfers'],
    ['GET', '/api/v1/auth/me'],
    ['POST', '/api/v1/sales'],
    ['POST', `/api/v1/transfers/${ID}/approve`],
  ])('%s %s without a session → 401 UNAUTHENTICATED', async (method, url) => {
    const res = await server()[method.toLowerCase() as 'get' | 'post'](url).expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(res.body.correlationId).toEqual(expect.any(String));
  });

  it('rejects an unknown or malformed session cookie', async () => {
    await server().get('/api/v1/products').set('Cookie', as('nope')).expect(401);
    await server().get('/api/v1/products').set('Cookie', 'other=1').expect(401);
  });

  it.each([
    ['POST', '/api/v1/sales'],
    ['POST', '/api/v1/receipts'],
    ['POST', '/api/v1/adjustments'],
    ['POST', '/api/v1/reservations'],
    ['POST', '/api/v1/transfers'],
    [`POST`, `/api/v1/transfers/${ID}/approve`],
    [`POST`, `/api/v1/transfers/${ID}/dispatch`],
  ])('analysts cannot write: %s %s → 403 FORBIDDEN', async (method, url) => {
    const res = await server().post(url).set('Cookie', as('tok-analyst')).expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(method).toBe('POST');
  });

  it('store managers cannot approve transfers', async () => {
    await server()
      .post(`/api/v1/transfers/${ID}/approve`)
      .set('Cookie', as('tok-store'))
      .expect(403);
  });

  it('analysts can read', async () => {
    // Passes the guard; the (mocked) database is never reached because validation fails first.
    await server()
      .get('/api/v1/products?pageSize=500')
      .set('Cookie', as('tok-analyst'))
      .expect(400);
  });

  it('every route declares @Roles(...) or @Public() — nothing relies on the default', () => {
    const discovery = app.get(DiscoveryService);
    const reflector = app.get(Reflector);
    const undeclared: string[] = [];
    let routes = 0;

    for (const wrapper of discovery.getControllers()) {
      const proto = Object.getPrototypeOf(wrapper.instance);
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        if (Reflect.getMetadata('path', handler) === undefined) continue; // not a route
        routes++;
        const targets = [handler, wrapper.metatype as object];
        const declared =
          reflector.getAllAndOverride(ROLES_KEY, targets) !== undefined ||
          reflector.getAllAndOverride(PUBLIC_KEY, targets) === true;
        if (!declared) undeclared.push(`${wrapper.metatype?.name}.${name}`);
      }
    }
    expect(routes).toBeGreaterThan(25);
    expect(undeclared).toEqual([]);
  });
});

// Validation runs before any service/database call, so a mocked DB is enough here.
describe('request validation (400 VALIDATION_FAILED)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await buildApp(async () => 1);
  });
  afterAll(async () => app.close());
  const get = (url: string) => request(app.getHttpServer()).get(url).set('Cookie', as('tok-admin'));

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
    ['/api/v1/transfers?status=LOST', 'status'],
    ['/api/v1/transfers/not-a-uuid', 'id'],
  ])('GET %s → 400 on %s', async (url, field) => {
    const res = await get(url).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: field })]),
    );
    expect(res.body.correlationId).toEqual(expect.any(String));
  });
});

describe('write endpoints validate before touching the database', () => {
  let app: INestApplication;
  const KEY = 'test-key-12345678';
  beforeAll(async () => {
    app = await buildApp(async () => 1);
  });
  afterAll(async () => app.close());
  const post = (url: string) =>
    request(app.getHttpServer()).post(`/api/v1${url}`).set('Cookie', as('tok-admin'));

  const BODIES: Record<string, object> = {
    '/sales': { locationId: ID, lines: [{ productId: ID, quantity: 1 }] },
    '/receipts': { locationId: ID, lines: [{ productId: ID, quantity: 1 }] },
    '/returns': { locationId: ID, productId: ID, quantity: 1, condition: 'SELLABLE' },
    '/adjustments': { locationId: ID, productId: ID, delta: 1, reason: 'count' },
    '/reservations': { locationId: ID, productId: ID, quantity: 1 },
    '/transfers': {
      sourceLocationId: ID,
      destinationLocationId: '00000000-0000-4000-8000-000000000001',
      lines: [{ productId: ID, quantity: 1 }],
    },
  };

  it.each(Object.keys(BODIES))('POST %s without an Idempotency-Key → 400', async (url) => {
    const res = await post(url).send(BODIES[url]).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details[0].path).toBe('Idempotency-Key');
  });

  it.each([
    ['/sales', { locationId: 'nope', lines: [] }],
    ['/receipts', { locationId: ID, lines: [{ productId: ID, quantity: -1 }] }],
    ['/returns', { locationId: ID, productId: ID, quantity: 1, condition: 'BROKEN' }],
    ['/adjustments', { locationId: ID, productId: ID, delta: 0, reason: 'x' }],
    ['/reservations', { locationId: ID, productId: ID, quantity: 0 }],
    [
      '/transfers',
      { sourceLocationId: ID, destinationLocationId: ID, lines: [{ productId: ID, quantity: 1 }] },
    ],
    ['/transfers', { sourceLocationId: ID, destinationLocationId: ID, lines: [] }],
  ])('POST %s with an invalid body → 400 with field details', async (url, body) => {
    const res = await post(url).set('Idempotency-Key', KEY).send(body).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details.length).toBeGreaterThan(0);
  });

  it('rejects invalid ids and list filters', async () => {
    await post('/reservations/not-a-uuid/release').expect(400);
    await post('/transfers/not-a-uuid/dispatch').expect(400);
    await request(app.getHttpServer())
      .get('/api/v1/reservations?status=OPEN')
      .set('Cookie', as('tok-admin'))
      .expect(400);
    await request(app.getHttpServer())
      .get('/api/v1/sales/not-a-uuid')
      .set('Cookie', as('tok-admin'))
      .expect(400);
  });

  it('login validates its body and needs no session', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'not-an-email', password: '' })
      .expect(400);
    expect(res.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual([
      'email',
      'password',
    ]);
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
