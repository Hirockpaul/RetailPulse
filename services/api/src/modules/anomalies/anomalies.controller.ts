import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { READ_ROLES, Roles, WRITE_ROLES } from '../../core/auth/roles';
import { idParamSchema } from '../../core/http/query';
import { Ctx, type RequestContext } from '../../core/http/request-context';
import { ZodValidationPipe } from '../../core/http/zod-validation.pipe';
import {
  type ListAnomaliesQuery,
  listAnomaliesQuerySchema,
  type ReviewBody,
  reviewBodySchema,
} from './anomalies.schemas';
import { AnomaliesService } from './anomalies.service';

const idParam = new ZodValidationPipe(idParamSchema);

/** Findings are advice for people; reviewing one never changes stock. Store-scoped. */
@Controller('anomalies')
export class AnomaliesController {
  constructor(private readonly anomalies: AnomaliesService) {}

  @Roles(...READ_ROLES)
  @Get()
  list(
    @Query(new ZodValidationPipe(listAnomaliesQuerySchema)) query: ListAnomaliesQuery,
    @Ctx() ctx: RequestContext,
  ) {
    return this.anomalies.list(query, ctx.user);
  }

  @Roles(...READ_ROLES)
  @Get(':id')
  get(@Param(idParam) { id }: { id: string }, @Ctx() ctx: RequestContext) {
    return this.anomalies.get(id, ctx.user);
  }

  /** Reword only backend-selected finding facts; reviewing and stock remain untouched. */
  @Roles(...READ_ROLES)
  @Post(':id/explanation/words')
  @HttpCode(200)
  explainInWords(@Param(idParam) { id }: { id: string }, @Ctx() ctx: RequestContext) {
    return this.anomalies.explainInWords(id, ctx);
  }

  /** One review step, e.g. { status: 'INVESTIGATING' } or { status: 'DISMISSED', note }. */
  @Roles(...WRITE_ROLES)
  @Post(':id/review')
  @HttpCode(200)
  review(
    @Param(idParam) { id }: { id: string },
    @Body(new ZodValidationPipe(reviewBodySchema)) body: ReviewBody,
    @Ctx() ctx: RequestContext,
  ) {
    return this.anomalies.review(id, body, ctx);
  }
}
