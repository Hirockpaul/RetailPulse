import { Injectable, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '../../core/auth/auth.types';
import { canAccessLocation } from '../../core/auth/access';
import type { Page } from '../../core/http/query';
import { LocationsRepository } from './locations.repository';
import type { ListLocationsQuery, Location } from './locations.schemas';

@Injectable()
export class LocationsService {
  constructor(private readonly repo: LocationsRepository) {}

  /** The location directory is visible to all roles; stock aggregates only where allowed. */
  async list(query: ListLocationsQuery, user: AuthUser): Promise<Page<Location>> {
    const { rows, total } = await this.repo.list(query);
    return {
      data: rows.map((l) => redactFor(user, l)),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  async getVisible(id: string, user: AuthUser): Promise<Location> {
    return redactFor(user, await this.get(id));
  }

  /** For other modules: the full record, or 404. Does not apply per-user redaction. */
  async get(id: string): Promise<Location> {
    const location = await this.repo.find(id);
    if (!location) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Location not found.' });
    }
    return location;
  }
}

function redactFor(user: AuthUser, location: Location): Location {
  return canAccessLocation(user, location.id)
    ? location
    : { ...location, skuCount: null, totalOnHand: null };
}
