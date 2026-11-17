import { z } from 'zod';
import { paginationSchema, searchSchema, sortSchema, uuidSchema } from '../../core/http/query';
import type { LocationType } from '../locations/locations.schemas';

export const MOVEMENT_TYPES = [
  'SALE',
  'RECEIPT',
  'TRANSFER_OUT',
  'TRANSFER_IN',
  'RETURN',
  'ADJUSTMENT',
  'RESERVATION',
  'RESERVATION_RELEASE',
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

// ----- requests

export const locationStockQuerySchema = paginationSchema.extend({
  q: searchSchema,
  sort: sortSchema(
    {
      sku: 'p.sku',
      name: 'p.name',
      onHand: 'b.on_hand',
      available: '(b.on_hand - b.reserved)',
    },
    'sku:asc',
  ),
});
export type LocationStockQuery = z.output<typeof locationStockQuerySchema>;

export const ledgerQuerySchema = paginationSchema.extend({
  locationId: uuidSchema.optional(),
  movementType: z.enum(MOVEMENT_TYPES).optional(),
});
export type LedgerQuery = z.output<typeof ledgerQuerySchema>;

// ----- responses

/** One product's stock at one location. available = onHand - reserved. */
export interface LocationStockRow {
  productId: string;
  sku: string;
  name: string;
  packSize: number;
  onHand: number;
  reserved: number;
  available: number;
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
  updatedAt: string;
}

export interface LedgerEntry {
  /** Monotonic ledger sequence number (as string: bigint). */
  id: string;
  locationId: string;
  locationCode: string;
  movementType: MovementType;
  onHandDelta: number;
  reservedDelta: number;
  onHandAfter: number;
  reservedAfter: number;
  reason: string | null;
  referenceType: string | null;
  referenceId: string | null;
  occurredAt: string;
}

/** Every stock response says when it was read, so the UI can show data freshness. */
export interface WithAsOf {
  asOf: string;
}
