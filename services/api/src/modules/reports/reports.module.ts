import { Module } from '@nestjs/common';
import { OverviewModule } from '../overview/overview.module';
import { ReportsController } from './reports.controller';
import { ReportsRepository } from './reports.repository';
import { ReportsService } from './reports.service';

/** Reports (V2 4c): snapshots from the ledger, work tables and the Overview; writes report_runs only. */
@Module({
  imports: [OverviewModule],
  controllers: [ReportsController],
  providers: [ReportsService, ReportsRepository],
})
export class ReportsModule {}
