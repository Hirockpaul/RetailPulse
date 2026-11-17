import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { READ_ROLES, Roles, WRITE_ROLES } from '../../core/auth/roles';
import { idParamSchema } from '../../core/http/query';
import { Ctx, type RequestContext } from '../../core/http/request-context';
import { ZodValidationPipe } from '../../core/http/zod-validation.pipe';
import { IdempotencyKey } from '../../core/idempotency/idempotency-key.decorator';
import { respond } from '../../core/idempotency/respond';
import {
  type CreateReservationBody,
  createReservationBodySchema,
  type ListReservationsQuery,
  listReservationsQuerySchema,
} from './reservations.schemas';
import { ReservationsService } from './reservations.service';

const idParam = new ZodValidationPipe(idParamSchema);

@Controller('reservations')
export class ReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  @Roles(...WRITE_ROLES)
  @Post()
  async create(
    @Body(new ZodValidationPipe(createReservationBodySchema)) body: CreateReservationBody,
    @IdempotencyKey() key: string,
    @Ctx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    return respond(res, await this.reservations.create(body, key, ctx));
  }

  @Roles(...WRITE_ROLES)
  @Post(':id/release')
  release(@Param(idParam) { id }: { id: string }, @Ctx() ctx: RequestContext) {
    return this.reservations.release(id, ctx);
  }

  @Roles(...READ_ROLES)
  @Get()
  list(
    @Query(new ZodValidationPipe(listReservationsQuerySchema)) query: ListReservationsQuery,
    @Ctx() ctx: RequestContext,
  ) {
    return this.reservations.list(query, ctx.user);
  }

  @Roles(...READ_ROLES)
  @Get(':id')
  get(@Param(idParam) { id }: { id: string }, @Ctx() ctx: RequestContext) {
    return this.reservations.get(id, ctx.user);
  }
}
