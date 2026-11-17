import { ForbiddenException } from '@nestjs/common';
import type { AuthUser } from './auth.types';

/**
 * Location-level access (object-level authorization).
 *  - ADMIN / INVENTORY_MANAGER / ANALYST: all locations.
 *  - STORE_MANAGER: only the stores in `locationIds`.
 *
 * Returns null for "all locations", otherwise the allowed ids — ready to pass to a
 * repository filter (`$n::uuid[] IS NULL OR location_id = ANY($n)`).
 */
export function accessibleLocationIds(user: AuthUser): string[] | null {
  return user.role === 'STORE_MANAGER' ? user.locationIds : null;
}

export function canAccessLocation(user: AuthUser, locationId: string): boolean {
  const ids = accessibleLocationIds(user);
  return ids === null || ids.includes(locationId);
}

export function forbidden(message = 'You do not have access to this location.') {
  return new ForbiddenException({ code: 'FORBIDDEN', message });
}

export function assertLocationAccess(user: AuthUser, locationId: string): void {
  if (!canAccessLocation(user, locationId)) throw forbidden();
}
