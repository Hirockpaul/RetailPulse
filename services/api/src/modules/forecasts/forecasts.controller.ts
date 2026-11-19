import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { APPROVER_ROLES, READ_ROLES, Roles } from '../../core/auth/roles';
import { Ctx, type RequestContext } from '../../core/http/request-context';
import { ZodValidationPipe } from '../../core/http/zod-validation.pipe';
import {
  type RunForecastBody,
  runForecastBodySchema,
  type SeriesQuery,
  seriesQuerySchema,
} from './forecasts.schemas';
import { ForecastsService } from './forecasts.service';

@Controller('forecasts')
export class ForecastsController {
  constructor(private readonly forecasts: ForecastsService) {}

  /** Starts a run in the forecasting service (answers 202; poll /forecasts/runs/latest). */
  @Roles(...APPROVER_ROLES)
  @Post('run')
  @HttpCode(202)
  run(
    @Body(new ZodValidationPipe(runForecastBodySchema)) body: RunForecastBody,
    @Ctx() ctx: RequestContext,
  ) {
    return this.forecasts.startRun(body, ctx);
  }

  @Roles(...READ_ROLES)
  @Get('runs/latest')
  latest() {
    return this.forecasts.overview();
  }

  /** History plus forecast for one product at one store (store managers: own stores only). */
  @Roles(...READ_ROLES)
  @Get('series')
  series(
    @Query(new ZodValidationPipe(seriesQuerySchema)) query: SeriesQuery,
    @Ctx() ctx: RequestContext,
  ) {
    return this.forecasts.series(query, ctx.user);
  }

  /** Why the first forecast day's forecast is what it is: the model's inputs as multiplying factors (SHAP). */
  @Roles(...READ_ROLES)
  @Get('explanation')
  explanation(
    @Query(new ZodValidationPipe(seriesQuerySchema)) query: SeriesQuery,
    @Ctx() ctx: RequestContext,
  ) {
    return this.forecasts.explanation(query, ctx.user);
  }

  /** Reword only the verified explanation facts; may use the optional server-side AI provider. */
  @Roles(...READ_ROLES)
  @Post('explanation/words')
  @HttpCode(200)
  explainInWords(
    @Body(new ZodValidationPipe(seriesQuerySchema)) body: SeriesQuery,
    @Ctx() ctx: RequestContext,
  ) {
    return this.forecasts.explainInWords(body, ctx);
  }
}
