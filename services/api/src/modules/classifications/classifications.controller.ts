import { Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { APPROVER_ROLES, READ_ROLES, Roles } from '../../core/auth/roles';
import { Ctx, type RequestContext } from '../../core/http/request-context';
import { ZodValidationPipe } from '../../core/http/zod-validation.pipe';
import {
  type ListClassificationsQuery,
  listClassificationsQuerySchema,
  type ScopeQuery,
  scopeQuerySchema,
} from './classifications.schemas';
import { ClassificationsService } from './classifications.service';

@Controller('classifications')
export class ClassificationsController {
  constructor(private readonly classifications: ClassificationsService) {}

  /** Products of one class (or all) with the numbers behind it. Network, or one store. */
  @Roles(...READ_ROLES)
  @Get()
  list(
    @Query(new ZodValidationPipe(listClassificationsQuerySchema)) query: ListClassificationsQuery,
    @Ctx() ctx: RequestContext,
  ) {
    return this.classifications.list(query, ctx.user);
  }

  /** The ABC × XYZ matrix: count and value share per class, the rules, and the policies. */
  @Roles(...READ_ROLES)
  @Get('summary')
  summary(
    @Query(new ZodValidationPipe(scopeQuerySchema)) query: ScopeQuery,
    @Ctx() ctx: RequestContext,
  ) {
    return this.classifications.summary(query, ctx.user);
  }

  @Roles(...APPROVER_ROLES)
  @Post('recalculate')
  @HttpCode(200)
  recalculate(@Ctx() ctx: RequestContext) {
    return this.classifications.recalculate(ctx.user);
  }
}
