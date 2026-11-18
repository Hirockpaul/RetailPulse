import { Module } from '@nestjs/common';
import { ClassificationsModule } from '../classifications/classifications.module';
import { ForecastsModule } from '../forecasts/forecasts.module';
import { PurchasingModule } from '../purchasing/purchasing.module';
import { SuppliersModule } from '../suppliers/suppliers.module';
import { TransfersModule } from '../transfers/transfers.module';
import { ReplenishmentController } from './replenishment.controller';
import { ReplenishmentRepository } from './replenishment.repository';
import { ReplenishmentService } from './replenishment.service';

@Module({
  imports: [
    ForecastsModule,
    TransfersModule,
    PurchasingModule,
    SuppliersModule,
    ClassificationsModule,
  ],
  controllers: [ReplenishmentController],
  providers: [ReplenishmentService, ReplenishmentRepository],
})
export class ReplenishmentModule {}
