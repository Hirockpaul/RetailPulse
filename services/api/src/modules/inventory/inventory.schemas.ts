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
  /** Units on APPROVED / DISPATCHED transfers heading here (derived, never stored). */
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
  /** Units on APPROVED / DISPATCHED transfers heading here (derived, never stored). */
  inbound: number;
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

// ----- write side (Day 3)

export const quantitySchema = z.number().int().min(1).max(100_000);

/** Rejects a lines array that repeats a product (merge quantities client-side instead). */
export const uniqueProducts = (lines: { productId: string }[]) =>
  new Set(lines.map((l) => l.productId)).size === lines.length;

export const receiptBodySchema = z.object({
  locationId: uuidSchema,
  /** Free-text document reference, e.g. a delivery note number. */
  reference: z.string().trim().min(1).max(100).optional(),
  lines: z
    .array(z.object({ productId: uuidSchema, quantity: quantitySchema }))
    .min(1)
    .max(100)
    .refine(uniqueProducts, 'Each product may appear only once.'),
});
export type ReceiptBody = z.output<typeof receiptBodySchema>;

export const RETURN_CONDITIONS = ['SELLABLE', 'DAMAGED'] as const;

export const returnBodySchema = z.object({
  locationId: uuidSchema,
  productId: uuidSchema,
  quantity: quantitySchema,
  /** SELLABLE goes back on the shelf; DAMAGED is recorded but not restocked. */
  condition: z.enum(RETURN_CONDITIONS),
  reason: z.string().trim().min(1).max(200).optional(),
});
export type ReturnBody = z.output<typeof returnBodySchema>;

export const adjustmentBodySchema = z.object({
  locationId: uuidSchema,
  productId: uuidSchema,
  delta: z
    .number()
    .int()
    .min(-100_000)
    .max(100_000)
    .refine((n) => n !== 0, 'Must not be 0.'),
  reason: z.string().trim().min(3).max(200),
});
export type AdjustmentBody = z.output<typeof adjustmentBodySchema>;

/** Input to the single stock write path. Deltas are signed; the type fixes their direction. */
export interface Movement {
  productId: string;
  locationId: string;
  type: MovementType;
  onHandDelta: number;
  reservedDelta?: number;
  reason?: string;
  referenceType?: string;
  referenceId?: string;
  correlationId?: string;
  /** The signed-in user who caused the movement. */
  actorId?: string;
}

/** The ledger row that was written, including the resulting balance. */
export interface MovementResult {
  ledgerId: string;
  productId: string;
  locationId: string;
  movementType: MovementType;
  onHandDelta: number;
  reservedDelta: number;
  onHandAfter: number;
  reservedAfter: number;
  occurredAt: Date;
}
