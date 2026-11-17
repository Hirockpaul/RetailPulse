import { Module } from '@nestjs/common';
import { IdempotencyModule } from '../../core/idempotency/idempotency.module';
import { InventoryModule } from '../inventory/inventory.module';
import { LocationsModule } from '../locations/locations.module';
import { TransfersController } from './transfers.controller';
import { TransfersRepository } from './transfers.repository';
import { TransfersService } from './transfers.service';

@Module({
  imports: [InventoryModule, LocationsModule, IdempotencyModule],
  controllers: [TransfersController],
  providers: [TransfersService, TransfersRepository],
})
export class TransfersModule {}
