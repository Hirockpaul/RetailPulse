import { getJson, type Page, qs } from './client';
import type { Location, LocationType } from './locations';

export interface LocationStockRow {
  productId: string;
  sku: string;
  name: string;
  packSize: number;
  onHand: number;
  reserved: number;
  available: number;
  /** Units on approved / dispatched transfers heading here. */
  inbound: number;
  updatedAt: string;
}

export interface ProductStockRow {
  locationId: string;
  locationCode: string;
  locationName: string;
  locationType: LocationType;
  onHand: number;
  reserved: number;
  available: number;
  /** Units on approved / dispatched transfers heading here. */
  inbound: number;
  updatedAt: string;
}

export interface LedgerEntry {
  id: string;
  locationId: string;
  locationCode: string;
  movementType: string;
  onHandDelta: number;
  reservedDelta: number;
  onHandAfter: number;
  reservedAfter: number;
  reason: string | null;
  referenceType: string | null;
  referenceId: string | null;
  occurredAt: string;
}

export type StockSort =
  'sku:asc' | 'name:asc' | 'onHand:asc' | 'onHand:desc' | 'available:asc' | 'available:desc';

export const getLocationStock = (
  locationId: string,
  p: { q?: string; sort?: StockSort; page?: number; pageSize?: number },
) =>
  getJson<Page<LocationStockRow> & { asOf: string; location: Location }>(
    `/locations/${locationId}/stock${qs({ ...p })}`,
  );

export const getProductStock = (productId: string) =>
  getJson<{ data: ProductStockRow[]; asOf: string }>(`/products/${productId}/stock`);

export const getProductLedger = (productId: string, p: { page?: number; pageSize?: number }) =>
  getJson<Page<LedgerEntry>>(`/products/${productId}/ledger${qs({ ...p })}`);
