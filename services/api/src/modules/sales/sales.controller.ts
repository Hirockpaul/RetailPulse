import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CorrelationId } from '../../core/http/correlation-id.decorator';
import { idParamSchema } from '../../core/http/query';
import { ZodValidationPipe } from '../../core/http/zod-validation.pipe';
import { IdempotencyKey } from '../../core/idempotency/idempotency-key.decorator';
import { respond } from '../../core/idempotency/respond';
import { type CreateSaleBody, createSaleBodySchema } from './sales.schemas';
import { SalesService } from './sales.service';

@Controller('sales')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Post()
  async create(
    @Body(new ZodValidationPipe(createSaleBodySchema)) body: CreateSaleBody,
    @IdempotencyKey() key: string,
    @CorrelationId() correlationId: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return respond(res, await this.sales.createSale(body, key, correlationId));
  }

  @Get(':id')
  get(@Param(new ZodValidationPipe(idParamSchema)) { id }: { id: string }) {
    return this.sales.getSale(id);
  }
}
