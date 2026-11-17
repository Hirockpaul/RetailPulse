import { SetMetadata } from '@nestjs/common';
import type { Role } from './auth.types';

export const ROLES_KEY = 'roles';
export const PUBLIC_KEY = 'isPublic';

/** Roles allowed on a route. A route with no @Roles() is ADMIN-only (deny by default). */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/** Route needs no session (login, health). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** Everyone who can sign in may read. Store managers are further limited to their stores. */
export const READ_ROLES: Role[] = ['ADMIN', 'INVENTORY_MANAGER', 'STORE_MANAGER', 'ANALYST'];

/** May record stock actions and request transfers (store managers: own stores only). */
export const WRITE_ROLES: Role[] = ['ADMIN', 'INVENTORY_MANAGER', 'STORE_MANAGER'];

/** May approve transfers (and, later, replenishment recommendations). */
export const APPROVER_ROLES: Role[] = ['ADMIN', 'INVENTORY_MANAGER'];
