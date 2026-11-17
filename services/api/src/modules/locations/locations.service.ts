import { Injectable, NotFoundException } from '@nestjs/common';
import type { Page } from '../../core/http/query';
import { LocationsRepository } from './locations.repository';
import type { ListLocationsQuery, Location } from './locations.schemas';

@Injectable()
export class LocationsService {
  constructor(private readonly repo: LocationsRepository) {}

  async list(query: ListLocationsQuery): Promise<Page<Location>> {
    const { rows, total } = await this.repo.list(query);
    return { data: rows, page: query.page, pageSize: query.pageSize, total };
  }

  async get(id: string): Promise<Location> {
    const location = await this.repo.find(id);
    if (!location) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Location not found.' });
    }
    return location;
  }
}
