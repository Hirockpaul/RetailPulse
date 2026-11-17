import { Controller, Get, Param, Query } from '@nestjs/common';
import { READ_ROLES, Roles } from '../../core/auth/roles';
import { idParamSchema } from '../../core/http/query';
import { Ctx, type RequestContext } from '../../core/http/request-context';
import { ZodValidationPipe } from '../../core/http/zod-validation.pipe';
import {
  type LedgerQuery,
  ledgerQuerySchema,
  type LocationStockQuery,
  locationStockQuerySchema,
} from './inventory.schemas';
import { InventoryService } from './inventory.service';

const idParam = new ZodValidationPipe(idParamSchema);

/** Stock reads. Store managers receive only their own stores' rows (see InventoryService). */
@Roles(...READ_ROLES)
@Controller()
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('locations/:id/stock')
  stockAtLocation(
    @Param(idParam) { id }: { id: string },
    @Query(new ZodValidationPipe(locationStockQuerySchema)) query: LocationStockQuery,
    @Ctx() ctx: RequestContext,
  ) {
    return this.inventory.stockAtLocation(id, query, ctx.user);
  }

  @Get('products/:id/stock')
  stockForProduct(@Param(idParam) { id }: { id: string }, @Ctx() ctx: RequestContext) {
    return this.inventory.stockForProduct(id, ctx.user);
  }

  @Get('products/:id/ledger')
  ledgerForProduct(
    @Param(idParam) { id }: { id: string },
    @Query(new ZodValidationPipe(ledgerQuerySchema)) query: LedgerQuery,
    @Ctx() ctx: RequestContext,
  ) {
    return this.inventory.ledgerForProduct(id, query, ctx.user);
  }
}
