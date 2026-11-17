import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { APPROVER_ROLES, READ_ROLES, Roles, WRITE_ROLES } from '../../core/auth/roles';
import { idParamSchema } from '../../core/http/query';
import { Ctx, type RequestContext } from '../../core/http/request-context';
import { ZodValidationPipe } from '../../core/http/zod-validation.pipe';
import { type ListPurchaseOrdersQuery, listPurchaseOrdersQuerySchema } from './purchasing.schemas';
import { PurchasingService } from './purchasing.service';

const idParam = new ZodValidationPipe(idParamSchema);

/** Orders are created by approving a replenishment recommendation, not directly. */
@Controller('purchase-orders')
export class PurchasingController {
  constructor(private readonly purchasing: PurchasingService) {}

  @Roles(...READ_ROLES)
  @Get()
  list(
    @Query(new ZodValidationPipe(listPurchaseOrdersQuerySchema)) query: ListPurchaseOrdersQuery,
    @Ctx() ctx: RequestContext,
  ) {
    return this.purchasing.list(query, ctx.user);
  }

  @Roles(...READ_ROLES)
  @Get(':id')
  get(@Param(idParam) { id }: { id: string }, @Ctx() ctx: RequestContext) {
    return this.purchasing.get(id, ctx.user);
  }

  /** Store managers can receive deliveries at their own store. */
  @Roles(...WRITE_ROLES)
  @Post(':id/receive')
  receive(@Param(idParam) { id }: { id: string }, @Ctx() ctx: RequestContext) {
    return this.purchasing.receive(id, ctx);
  }

  @Roles(...APPROVER_ROLES)
  @Post(':id/cancel')
  cancel(@Param(idParam) { id }: { id: string }, @Ctx() ctx: RequestContext) {
    return this.purchasing.cancel(id, ctx);
  }
}
