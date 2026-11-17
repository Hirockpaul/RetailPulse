import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { ForecastsModule } from '../forecasts/forecasts.module';
import { OverviewController } from './overview.controller';
import { OverviewRepository } from './overview.repository';
import { OverviewService } from './overview.service';

/** Read model for the landing page. Reads across domains; writes nothing. */
@Module({
  imports: [ForecastsModule, EventsModule],
  controllers: [OverviewController],
  providers: [OverviewService, OverviewRepository],
})
export class OverviewModule {}
