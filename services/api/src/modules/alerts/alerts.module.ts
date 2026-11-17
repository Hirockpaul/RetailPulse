import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { InventoryModule } from '../inventory/inventory.module';
import { AlertsController } from './alerts.controller';
import { AlertsRepository } from './alerts.repository';
import { AlertsService } from './alerts.service';
import { LowStockConsumer } from './low-stock.consumer';

@Module({
  imports: [EventsModule, InventoryModule],
  controllers: [AlertsController],
  providers: [AlertsService, AlertsRepository, LowStockConsumer],
})
export class AlertsModule {}
