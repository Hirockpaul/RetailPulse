import type { AuthUser } from '../api/auth';

/** UI hints only — the API enforces every one of these rules on the server. */
export const canWrite = (u: AuthUser) => u.role !== 'ANALYST';
export const canApprove = (u: AuthUser) => u.role === 'ADMIN' || u.role === 'INVENTORY_MANAGER';
export const isStoreScoped = (u: AuthUser) => u.role === 'STORE_MANAGER';
export const canAccessLocation = (u: AuthUser, locationId: string) =>
  !isStoreScoped(u) || u.locationIds.includes(locationId);

export const ROLE_LABEL: Record<AuthUser['role'], string> = {
  ADMIN: 'Admin',
  INVENTORY_MANAGER: 'Inventory manager',
  STORE_MANAGER: 'Store manager',
  ANALYST: 'Analyst',
};
