import { Module } from '@nestjs/common';
import { ForecastsModule } from '../forecasts/forecasts.module';
import { MlController } from './ml.controller';
import { MlRepository } from './ml.repository';
import { MlService } from './ml.service';
import { MonitoringController } from './monitoring.controller';
import { MonitoringRepository } from './monitoring.repository';
import { MonitoringService } from './monitoring.service';

/** Model registry (3a/3b) and monitoring (3c-2). Calls the forecasting service via forecasts. */
@Module({
  imports: [ForecastsModule],
  controllers: [MlController, MonitoringController],
  providers: [MlService, MlRepository, MonitoringService, MonitoringRepository],
})
export class MlModule {}
