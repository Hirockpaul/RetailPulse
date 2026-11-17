import type { Request } from 'express';

export const ROLES = ['ADMIN', 'INVENTORY_MANAGER', 'STORE_MANAGER', 'ANALYST'] as const;
export type Role = (typeof ROLES)[number];

/** The signed-in user, loaded from the session on every request. */
export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  /** Stores a STORE_MANAGER may work in. Empty for other roles (they are not store-scoped). */
  locationIds: string[];
}

export interface AuthedRequest extends Request {
  user?: AuthUser;
}

export const SESSION_COOKIE = 'rp_session';
export const SESSION_TTL_HOURS = 8;
