import { INestApplication } from '@nestjs/common';
import request from 'supertest';

/** Fictional demo accounts created by scripts/seed.mjs. */
export const DEMO = {
  admin: 'admin@retailpulse.test',
  inventory: 'inventory@retailpulse.test',
  store1: 'store1@retailpulse.test', // STORE_MANAGER of STR-01
  store2: 'store2@retailpulse.test', // STORE_MANAGER of STR-02
  analyst: 'analyst@retailpulse.test',
} as const;

export const demoPassword = () => process.env.DEMO_PASSWORD ?? 'ci-demo-password-1';

/** Sign in and return the `Cookie` header value for later requests. */
export async function login(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password: demoPassword() })
    .expect(200);
  const setCookie = res.headers['set-cookie'] as unknown as string[];
  return setCookie[0].split(';')[0];
}
