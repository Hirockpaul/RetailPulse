import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { APPROVER_ROLES, READ_ROLES, Roles } from '../../core/auth/roles';
import { idParamSchema } from '../../core/http/query';
import { Ctx, type RequestContext } from '../../core/http/request-context';
import { ZodValidationPipe } from '../../core/http/zod-validation.pipe';
import {
  type DecisionBody,
  decisionBodySchema,
  type ListRecommendationsQuery,
  listRecommendationsQuerySchema,
} from './replenishment.schemas';
import { ReplenishmentService } from './replenishment.service';

const idParam = new ZodValidationPipe(idParamSchema);
const decisionBody = new ZodValidationPipe(decisionBodySchema);

/** Suggestions only: nothing is ordered or moved until a manager approves a recommendation. */
@Controller('replenishment')
export class ReplenishmentController {
  constructor(private readonly replenishment: ReplenishmentService) {}

  /** Compute fresh recommendations from the latest forecast (replaces the pending ones). */
  @Roles(...APPROVER_ROLES)
  @Post('generate')
  @HttpCode(200)
  generate() {
    return this.replenishment.generate();
  }

  @Roles(...READ_ROLES)
  @Get('recommendations')
  list(
    @Query(new ZodValidationPipe(listRecommendationsQuerySchema)) query: ListRecommendationsQuery,
    @Ctx() ctx: RequestContext,
  ) {
    return this.replenishment.list(query, ctx.user);
  }

  @Roles(...READ_ROLES)
  @Get('recommendations/:id')
  get(@Param(idParam) { id }: { id: string }, @Ctx() ctx: RequestContext) {
    return this.replenishment.get(id, ctx.user);
  }

  @Roles(...APPROVER_ROLES)
  @Post('recommendations/:id/approve')
  @HttpCode(200)
  approve(
    @Param(idParam) { id }: { id: string },
    @Body(decisionBody) body: DecisionBody,
    @Ctx() ctx: RequestContext,
  ) {
    return this.replenishment.approve(id, body, ctx);
  }

  @Roles(...APPROVER_ROLES)
  @Post('recommendations/:id/reject')
  @HttpCode(200)
  reject(
    @Param(idParam) { id }: { id: string },
    @Body(decisionBody) body: DecisionBody,
    @Ctx() ctx: RequestContext,
  ) {
    return this.replenishment.reject(id, body, ctx);
  }
}
