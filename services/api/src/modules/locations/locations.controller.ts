import { Controller, Get, Param, Query } from '@nestjs/common';
import { idParamSchema } from '../../core/http/query';
import { ZodValidationPipe } from '../../core/http/zod-validation.pipe';
import { type ListLocationsQuery, listLocationsQuerySchema } from './locations.schemas';
import { LocationsService } from './locations.service';

@Controller('locations')
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Get()
  list(@Query(new ZodValidationPipe(listLocationsQuerySchema)) query: ListLocationsQuery) {
    return this.locations.list(query);
  }

  @Get(':id')
  get(@Param(new ZodValidationPipe(idParamSchema)) { id }: { id: string }) {
    return this.locations.get(id);
  }
}
