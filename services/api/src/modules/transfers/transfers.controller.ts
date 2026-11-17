import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { APPROVER_ROLES, READ_ROLES, Roles, WRITE_ROLES } from '../../core/auth/roles';
import { idParamSchema } from '../../core/http/query';
import { Ctx, type RequestContext } from '../../core/http/request-context';
import { ZodValidationPipe } from '../../core/http/zod-validation.pipe';
import { IdempotencyKey } from '../../core/idempotency/idempotency-key.decorator';
import { respond } from '../../core/idempotency/respond';
import {
  type CreateTransferBody,
  createTransferBodySchema,
  type ListTransfersQuery,
  listTransfersQuerySchema,
} from './transfers.schemas';
import { TransfersService } from './transfers.service';

const idParam = new ZodValidationPipe(idParamSchema);

@Controller('transfers')
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  @Roles(...WRITE_ROLES)
  @Post()
  async create(
    @Body(new ZodValidationPipe(createTransferBodySchema)) body: CreateTransferBody,
    @IdempotencyKey() key: string,
    @Ctx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    return respond(res, await this.transfers.create(body, key, ctx));
  }

  @Roles(...READ_ROLES)
  @Get()
  list(
    @Query(new ZodValidationPipe(listTransfersQuerySchema)) query: ListTransfersQuery,
    @Ctx() ctx: RequestContext,
  ) {
    return this.transfers.list(query, ctx.user);
  }

  @Roles(...READ_ROLES)
  @Get(':id')
  get(@Param(idParam) { id }: { id: string }, @Ctx() ctx: RequestContext) {
    return this.transfers.get(id, ctx.user);
  }

  /** Only admins and inventory managers approve. */
  @Roles(...APPROVER_ROLES)
  @Post(':id/approve')
  approve(@Param(idParam) { id }: { id: string }, @Ctx() ctx: RequestContext) {
    return this.transfers.approve(id, ctx);
  }

  /** Source side: store managers only for their own source store. */
  @Roles(...WRITE_ROLES)
  @Post(':id/dispatch')
  dispatch(@Param(idParam) { id }: { id: string }, @Ctx() ctx: RequestContext) {
    return this.transfers.dispatch(id, ctx);
  }

  /** Destination side: store managers only for their own destination store. */
  @Roles(...WRITE_ROLES)
  @Post(':id/receive')
  receive(@Param(idParam) { id }: { id: string }, @Ctx() ctx: RequestContext) {
    return this.transfers.receive(id, ctx);
  }

  @Roles(...WRITE_ROLES)
  @Post(':id/cancel')
  cancel(@Param(idParam) { id }: { id: string }, @Ctx() ctx: RequestContext) {
    return this.transfers.cancel(id, ctx);
  }
}
