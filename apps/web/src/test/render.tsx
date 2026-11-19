import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import type { AuthUser, Role } from '../api/auth';
import { AuthProvider, useAuth } from '../lib/auth';

export const STR1 = '11111111-1111-4111-8111-111111111111';
export const STR2 = '22222222-2222-4222-8222-222222222222';

export const userFor = (role: Role): AuthUser => ({
  id: `user-${role}`,
  email: `${role.toLowerCase()}@retailpulse.test`,
  displayName: `Test ${role}`,
  role,
  locationIds: role === 'STORE_MANAGER' ? [STR1] : [],
});

/** A route's answer: JSON with a status, or `'pending'` to stay loading forever. */
export type Answer = { status?: number; body: unknown } | 'pending';

/**
 * Fakes the network (`fetch`): `/auth/me` answers as `role`; other paths come from `routes`
 * (matched on the path after /api/v1, query string included, first prefix match wins).
 * Returns the spy so tests can count calls.
 */
export function fakeApi(role: Role, routes: Record<string, Answer | (() => Answer)>) {
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input).replace(/^\/api\/v1/, '');
    if (path === '/auth/me') return json({ user: userFor(role) });
    const key = Object.keys(routes).find((k) => path.startsWith(k));
    if (!key) return json({ error: { code: 'NOT_FOUND', message: `no fake for ${path}` } }, 404);
    const raw = routes[key];
    const answer = typeof raw === 'function' ? raw() : raw;
    if (answer === 'pending') return new Promise<Response>(() => undefined);
    return json(answer.body, answer.status ?? 200);
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function SignedIn({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  return state.status === 'authenticated' ? <>{children}</> : null;
}

/** Renders `ui` for the signed-in user faked by fakeApi(). */
export const renderSignedIn = (ui: ReactNode) =>
  render(
    <AuthProvider>
      <SignedIn>{ui}</SignedIn>
    </AuthProvider>,
  );

export const page = <T,>(data: T[]) => ({ data, page: 1, pageSize: 20, total: data.length });
