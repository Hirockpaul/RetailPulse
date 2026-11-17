import { Injectable } from '@nestjs/common';
import type { Page } from '../../core/http/query';
import { CatalogService } from '../catalog/catalog.service';
import { LocationsService } from '../locations/locations.service';
import type { Location } from '../locations/locations.schemas';
import { InventoryRepository } from './inventory.repository';
import type {
  LedgerEntry,
  LedgerQuery,
  LocationStockQuery,
  LocationStockRow,
  ProductStockRow,
  WithAsOf,
} from './inventory.schemas';

/**
 * The inventory module is the only owner of inventory_balances / inventory_ledger.
 * Day 2: read side. Day 3 adds applyMovement(), the single write path.
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly repo: InventoryRepository,
    private readonly catalog: CatalogService,
    private readonly locations: LocationsService,
  ) {}

  async stockAtLocation(
    locationId: string,
    query: LocationStockQuery,
  ): Promise<Page<LocationStockRow> & WithAsOf & { location: Location }> {
    const location = await this.locations.get(locationId); // 404 if missing
    const asOf = new Date().toISOString();
    const { rows, total } = await this.repo.stockAtLocation(locationId, query);
    return { location, data: rows, page: query.page, pageSize: query.pageSize, total, asOf };
  }

  async stockForProduct(productId: string): Promise<{ data: ProductStockRow[] } & WithAsOf> {
    await this.catalog.assertProductExists(productId);
    const asOf = new Date().toISOString();
    return { data: await this.repo.stockForProduct(productId), asOf };
  }

  async ledgerForProduct(productId: string, query: LedgerQuery): Promise<Page<LedgerEntry>> {
    await this.catalog.assertProductExists(productId);
    const { rows, total } = await this.repo.ledgerForProduct(productId, query);
    return { data: rows, page: query.page, pageSize: query.pageSize, total };
  }
}
