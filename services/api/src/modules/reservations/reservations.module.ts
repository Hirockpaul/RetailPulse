import { Module } from '@nestjs/common';
import { IdempotencyModule } from '../../core/idempotency/idempotency.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ReservationsController } from './reservations.controller';
import { ReservationsRepository } from './reservations.repository';
import { ReservationsService } from './reservations.service';

@Module({
  imports: [InventoryModule, IdempotencyModule],
  controllers: [ReservationsController],
  providers: [ReservationsService, ReservationsRepository],
})
export class ReservationsModule {}
