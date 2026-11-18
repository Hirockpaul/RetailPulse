import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { APPROVER_ROLES, READ_ROLES, Roles } from '../../core/auth/roles';
import { MonitoringService } from './monitoring.service';

/** Model monitoring: read for everyone signed in; running it now is for approvers. */
@Controller('ml/monitoring')
export class MonitoringController {
  constructor(private readonly monitoring: MonitoringService) {}

  @Roles(...READ_ROLES)
  @Get()
  overview() {
    return this.monitoring.overview();
  }

  @Roles(...APPROVER_ROLES)
  @Post('run')
  @HttpCode(200)
  run() {
    return this.monitoring.run();
  }
}
