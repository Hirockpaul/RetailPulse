import { Module } from '@nestjs/common';
import { ForecastClient } from './forecast.client';
import { ForecastsController } from './forecasts.controller';
import { ForecastsRepository } from './forecasts.repository';
import { ForecastsService } from './forecasts.service';

@Module({
  controllers: [ForecastsController],
  providers: [ForecastsService, ForecastsRepository, ForecastClient],
  exports: [ForecastsService],
})
export class ForecastsModule {}
