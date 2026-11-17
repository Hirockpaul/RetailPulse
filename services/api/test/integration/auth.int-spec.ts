/** Login, sessions, logout, lockout and disabled accounts against a real, freshly seeded database. */
import { createHash } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { loadEnv } from '../../src/core/config/env';
import { DEMO, demoPassword } from './auth-helpers';
import { prepareTestDatabase, releaseTestDatabase } from './test-db';

let app: INestApplication;
let db: pg.Client;
const api = () => request(app.getHttpServer());
const loginReq = (email: string, password = demoPassword()) =>
  api().post('/api/v1/auth/login').send({ email, password });
const cookieOf = (res: request.Response) => (res.headers['set-cookie'] as unknown as string[])[0];

beforeAll(async () => {
  const url = await prepareTestDatabase();
  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: url });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).compile();
  app = configureApp(moduleRef.createNestApplication({ logger: false }));
  await app.init();
  db = new pg.Client({ connectionString: url });
  await db.connect();
}, 60_000);

afterAll(async () => {
  await db?.end();
  await app?.close();
  await releaseTestDatabase();
});

describe('POST /auth/login', () => {
  it('signs in a seeded demo account and sets a hardened session cookie', async () => {
    const res = await loginReq(DEMO.store1).expect(200);
    expect(res.body.user).toMatchObject({
      email: DEMO.store1,
      displayName: 'Sam Store-One',
      role: 'STORE_MANAGER',
      locationIds: [expect.any(String)],
    });
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash/i);

    const cookie = cookieOf(res);
    expect(cookie).toMatch(/^rp_session=[A-Za-z0-9_-]{40,}/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\//i);
    expect(cookie).toMatch(/Expires=/i);
    expect(cookie).not.toMatch(/Secure/i); // Secure is added when NODE_ENV=production
  });

  it('stores only a hash of the session token', async () => {
    const res = await loginReq(DEMO.analyst).expect(200);
    const token = cookieOf(res).split(';')[0].split('=')[1];
    const { rows } = await db.query('SELECT id_hash FROM sessions');
    const hashes = rows.map((r) => r.id_hash);
    expect(hashes).not.toContain(token);
    expect(hashes).toContain(createHash('sha256').update(token).digest('hex'));
  });

  it('lets the session reach /auth/me, and /auth/me reports the same user', async () => {
    const login = await loginReq(DEMO.inventory).expect(200);
    const me = await api()
      .get('/api/v1/auth/me')
      .set('Cookie', cookieOf(login).split(';')[0])
      .expect(200);
    expect(me.body.user).toMatchObject({ email: DEMO.inventory, role: 'INVENTORY_MANAGER' });
  });

  it('gives wrong password and unknown email the identical 401', async () => {
    const wrong = await loginReq(DEMO.admin, 'definitely-wrong').expect(401);
    const unknown = await loginReq('nobody@retailpulse.test', 'definitely-wrong').expect(401);
    expect(wrong.body.error).toEqual({
      code: 'INVALID_CREDENTIALS',
      message: 'Incorrect email or password.',
    });
    expect(unknown.body.error).toEqual(wrong.body.error);
    expect(wrong.headers['set-cookie']).toBeUndefined();
  });

  it('is case-insensitive for the email address', async () => {
    await loginReq('ADMIN@RetailPulse.test').expect(200);
  });

  it('refuses a disabled account, and ends its existing sessions', async () => {
    const login = await loginReq(DEMO.store2).expect(200);
    const cookie = cookieOf(login).split(';')[0];
    await api().get('/api/v1/auth/me').set('Cookie', cookie).expect(200);

    await db.query('UPDATE users SET is_active = false WHERE email = $1', [DEMO.store2]);
    try {
      await api().get('/api/v1/auth/me').set('Cookie', cookie).expect(401);
      await loginReq(DEMO.store2).expect(401);
    } finally {
      await db.query('UPDATE users SET is_active = true WHERE email = $1', [DEMO.store2]);
    }
    await loginReq(DEMO.store2).expect(200);
  });

  it('locks out repeated failures for the same email, but not other accounts', async () => {
    const email = 'lockout-test@retailpulse.test';
    for (let i = 0; i < 5; i++) await loginReq(email, 'wrong-password').expect(401);

    const blocked = await loginReq(email, 'wrong-password').expect(429);
    expect(blocked.body.error).toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      details: [{ retryAfterSeconds: expect.any(Number) }],
    });

    await loginReq(DEMO.admin).expect(200); // other accounts are unaffected
  });

  it('a successful login clears earlier failures', async () => {
    for (let i = 0; i < 4; i++) await loginReq(DEMO.analyst, 'wrong-password').expect(401);
    await loginReq(DEMO.analyst).expect(200);
    for (let i = 0; i < 4; i++) await loginReq(DEMO.analyst, 'wrong-password').expect(401);
    await loginReq(DEMO.analyst).expect(200); // would be 429 if the counter had not reset
  });

  it('validates the request body', async () => {
    const res = await api()
      .post('/api/v1/auth/login')
      .send({ email: 'not-an-email', password: '' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('sessions', () => {
  it('logout invalidates the session and clears the cookie', async () => {
    const login = await loginReq(DEMO.admin).expect(200);
    const cookie = cookieOf(login).split(';')[0];

    const out = await api().post('/api/v1/auth/logout').set('Cookie', cookie).expect(200);
    expect(cookieOf(out)).toMatch(/^rp_session=;/);
    await api().get('/api/v1/auth/me').set('Cookie', cookie).expect(401);
  });

  it('logout without a session still succeeds', async () => {
    await api().post('/api/v1/auth/logout').expect(200);
  });

  it('an expired session is rejected', async () => {
    const login = await loginReq(DEMO.inventory).expect(200);
    const cookie = cookieOf(login).split(';')[0];
    await db.query(
      `UPDATE sessions SET expires_at = now() - interval '1 minute'
        WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
      [DEMO.inventory],
    );
    await api().get('/api/v1/auth/me').set('Cookie', cookie).expect(401);
  });

  it('every protected route rejects anonymous requests; health stays public', async () => {
    await api().get('/api/v1/health').expect(200);
    for (const url of ['/products', '/locations', '/transfers', '/reservations', '/auth/me']) {
      const res = await api().get(`/api/v1${url}`).expect(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('seeded hashes are scrypt and never the plain password', async () => {
    const { rows } = await db.query('SELECT password_hash FROM users');
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(r.password_hash).toMatch(/^scrypt\$32768\$8\$3\$/);
      expect(r.password_hash).not.toContain(demoPassword());
    }
  });
});
