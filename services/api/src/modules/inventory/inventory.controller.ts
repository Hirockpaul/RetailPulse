import { Controller, Get, Param, Query } from '@nestjs/common';
import { idParamSchema } from '../../core/http/query';
import { ZodValidationPipe } from '../../core/http/zod-validation.pipe';
import {
  type LedgerQuery,
  ledgerQuerySchema,
  type LocationStockQuery,
  locationStockQuerySchema,
} from './inventory.schemas';
import { InventoryService } from './inventory.service';

const idParam = new ZodValidationPipe(idParamSchema);

@Controller()
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('locations/:id/stock')
  stockAtLocation(
    @Param(idParam) { id }: { id: string },
    @Query(new ZodValidationPipe(locationStockQuerySchema)) query: LocationStockQuery,
  ) {
    return this.inventory.stockAtLocation(id, query);
  }

  @Get('products/:id/stock')
  stockForProduct(@Param(idParam) { id }: { id: string }) {
    return this.inventory.stockForProduct(id);
  }

  @Get('products/:id/ledger')
  ledgerForProduct(
    @Param(idParam) { id }: { id: string },
    @Query(new ZodValidationPipe(ledgerQuerySchema)) query: LedgerQuery,
  ) {
    return this.inventory.ledgerForProduct(id, query);
  }
}
