import { Controller, Get, Post, Query } from '@nestjs/common';
import { APPROVER_ROLES, READ_ROLES, Roles } from '../../core/auth/roles';
import { Ctx, type RequestContext } from '../../core/http/request-context';
import { ZodValidationPipe } from '../../core/http/zod-validation.pipe';
import { type ListAlertsQuery, listAlertsQuerySchema } from './alerts.schemas';
import { AlertsService } from './alerts.service';

@Controller('alerts')
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Roles(...READ_ROLES)
  @Get()
  list(
    @Query(new ZodValidationPipe(listAlertsQuerySchema)) query: ListAlertsQuery,
    @Ctx() ctx: RequestContext,
  ) {
    return this.alerts.list(query, ctx.user);
  }

  /** Re-check all low positions and open alerts against current stock. */
  @Roles(...APPROVER_ROLES)
  @Post('rescan')
  rescan() {
    return this.alerts.rescan();
  }
}
