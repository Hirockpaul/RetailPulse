import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { READ_ROLES, Roles, WRITE_ROLES } from '../../core/auth/roles';
import { idParamSchema } from '../../core/http/query';
import { Ctx, type RequestContext } from '../../core/http/request-context';
import { ZodValidationPipe } from '../../core/http/zod-validation.pipe';
import { IdempotencyKey } from '../../core/idempotency/idempotency-key.decorator';
import { respond } from '../../core/idempotency/respond';
import { type CreateSaleBody, createSaleBodySchema } from './sales.schemas';
import { SalesService } from './sales.service';

@Controller('sales')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Roles(...WRITE_ROLES)
  @Post()
  async create(
    @Body(new ZodValidationPipe(createSaleBodySchema)) body: CreateSaleBody,
    @IdempotencyKey() key: string,
    @Ctx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    return respond(res, await this.sales.createSale(body, key, ctx));
  }

  @Roles(...READ_ROLES)
  @Get(':id')
  get(
    @Param(new ZodValidationPipe(idParamSchema)) { id }: { id: string },
    @Ctx() ctx: RequestContext,
  ) {
    return this.sales.getSale(id, ctx.user);
  }
}
