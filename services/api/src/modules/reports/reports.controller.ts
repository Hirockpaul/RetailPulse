import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { READ_ROLES, Roles } from '../../core/auth/roles';
import { idParamSchema } from '../../core/http/query';
import { Ctx, type RequestContext } from '../../core/http/request-context';
import { ZodValidationPipe } from '../../core/http/zod-validation.pipe';
import {
  type GenerateReport,
  generateReportSchema,
  type ListReportsQuery,
  listReportsQuerySchema,
} from './reports.schemas';
import { ReportsService } from './reports.service';

/**
 * Reports for every signed-in role; store managers only for their own stores (no network reports).
 * Generating writes one report row and nothing else.
 */
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Roles(...READ_ROLES)
  @Post('generate')
  generate(
    @Body(new ZodValidationPipe(generateReportSchema)) body: GenerateReport,
    @Ctx() ctx: RequestContext,
  ) {
    return this.reports.generate(body, ctx.user);
  }

  @Roles(...READ_ROLES)
  @Get()
  list(
    @Query(new ZodValidationPipe(listReportsQuerySchema)) q: ListReportsQuery,
    @Ctx() ctx: RequestContext,
  ) {
    return this.reports.list(q, ctx.user);
  }

  @Roles(...READ_ROLES)
  @Post(':id/summary/words')
  @HttpCode(200)
  summarizeInWords(
    @Param(new ZodValidationPipe(idParamSchema)) { id }: { id: string },
    @Ctx() ctx: RequestContext,
  ) {
    return this.reports.summarizeInWords(id, ctx.user);
  }

  @Roles(...READ_ROLES)
  @Get(':id')
  get(
    @Param(new ZodValidationPipe(idParamSchema)) { id }: { id: string },
    @Ctx() ctx: RequestContext,
  ) {
    return this.reports.get(id, ctx.user);
  }

  @Roles(...READ_ROLES)
  @Get(':id/export.csv')
  async csv(
    @Param(new ZodValidationPipe(idParamSchema)) { id }: { id: string },
    @Ctx() ctx: RequestContext,
    @Res() res: Response,
  ) {
    const { fileName, body } = await this.reports.csv(id, ctx.user);
    res
      .status(200)
      .setHeader('Content-Type', 'text/csv; charset=utf-8')
      .setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
      .send(body);
  }
}
