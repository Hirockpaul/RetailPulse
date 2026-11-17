import { Controller, Get, Param, Query } from '@nestjs/common';
import { READ_ROLES, Roles } from '../../core/auth/roles';
import { idParamSchema } from '../../core/http/query';
import { Ctx, type RequestContext } from '../../core/http/request-context';
import { ZodValidationPipe } from '../../core/http/zod-validation.pipe';
import { type ListLocationsQuery, listLocationsQuerySchema } from './locations.schemas';
import { LocationsService } from './locations.service';

@Roles(...READ_ROLES)
@Controller('locations')
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(listLocationsQuerySchema)) query: ListLocationsQuery,
    @Ctx() ctx: RequestContext,
  ) {
    return this.locations.list(query, ctx.user);
  }

  @Get(':id')
  get(
    @Param(new ZodValidationPipe(idParamSchema)) { id }: { id: string },
    @Ctx() ctx: RequestContext,
  ) {
    return this.locations.getVisible(id, ctx.user);
  }
}
