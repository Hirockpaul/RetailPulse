import { getJson, postJson } from './client';

export type Role = 'ADMIN' | 'INVENTORY_MANAGER' | 'STORE_MANAGER' | 'ANALYST';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  /** Stores a store manager may work in (empty for other roles). */
  locationIds: string[];
}

export const login = (email: string, password: string) =>
  postJson<{ user: AuthUser }>('/auth/login', { email, password });

export const logout = () => postJson<{ ok: boolean }>('/auth/logout', {});

export const fetchMe = () => getJson<{ user: AuthUser }>('/auth/me');
