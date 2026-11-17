import { Module } from '@nestjs/common';
import { IdempotencyModule } from '../../core/idempotency/idempotency.module';
import { CatalogModule } from '../catalog/catalog.module';
import { LocationsModule } from '../locations/locations.module';
import { InventoryController } from './inventory.controller';
import { InventoryMovementsController } from './inventory-movements.controller';
import { InventoryRepository } from './inventory.repository';
import { InventoryService } from './inventory.service';

@Module({
  imports: [CatalogModule, LocationsModule, IdempotencyModule],
  controllers: [InventoryController, InventoryMovementsController],
  providers: [InventoryService, InventoryRepository],
  exports: [InventoryService],
})
export class InventoryModule {}
