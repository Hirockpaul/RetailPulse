import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CorrelationId } from '../../core/http/correlation-id.decorator';
import { idParamSchema } from '../../core/http/query';
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

  @Post()
  async create(
    @Body(new ZodValidationPipe(createReservationBodySchema)) body: CreateReservationBody,
    @IdempotencyKey() key: string,
    @CorrelationId() correlationId: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return respond(res, await this.reservations.create(body, key, correlationId));
  }

  @Post(':id/release')
  release(
    @Param(idParam) { id }: { id: string },
    @CorrelationId() correlationId: string | undefined,
  ) {
    return this.reservations.release(id, correlationId);
  }

  @Get()
  list(@Query(new ZodValidationPipe(listReservationsQuerySchema)) query: ListReservationsQuery) {
    return this.reservations.list(query);
  }

  @Get(':id')
  get(@Param(idParam) { id }: { id: string }) {
    return this.reservations.get(id);
  }
}
