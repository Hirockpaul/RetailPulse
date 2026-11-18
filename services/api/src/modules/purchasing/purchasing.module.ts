import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { SuppliersModule } from '../suppliers/suppliers.module';
import { PurchasingController } from './purchasing.controller';
import { PurchasingRepository } from './purchasing.repository';
import { PurchasingService } from './purchasing.service';

@Module({
  imports: [InventoryModule, SuppliersModule],
  controllers: [PurchasingController],
  providers: [PurchasingService, PurchasingRepository],
  exports: [PurchasingService],
})
export class PurchasingModule {}
