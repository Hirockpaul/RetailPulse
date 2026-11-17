import { z } from 'zod';
import { paginationSchema, uuidSchema } from '../../core/http/query';

export const ALERT_KINDS = ['LOW_STOCK', 'OUT_OF_STOCK'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
export const ALERT_STATUSES = ['OPEN', 'RESOLVED'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export type StockState = 'OK' | AlertKind;

/**
 * The rule behind the alerts (kept deliberately simple and explainable):
 *   available = on hand − reserved
 *   available ≤ 0               → OUT_OF_STOCK  (severity HIGH)
 *   available < one pack        → LOW_STOCK     (severity MEDIUM)
 *   otherwise                   → OK
 * Day 6 replaces "one pack" with a forecast-based reorder point.
 */
export function stockState(available: number, packSize: number): StockState {
  if (available <= 0) return 'OUT_OF_STOCK';
  if (available < packSize) return 'LOW_STOCK';
  return 'OK';
}

export const SEVERITY: Record<AlertKind, 'MEDIUM' | 'HIGH'> = {
  LOW_STOCK: 'MEDIUM',
  OUT_OF_STOCK: 'HIGH',
};

/** The part of an inventory.movement.recorded payload this consumer needs. */
export const movementPayloadSchema = z.object({
  productId: uuidSchema,
  locationId: uuidSchema,
  ledgerId: z.string().min(1),
});

export const listAlertsQuerySchema = paginationSchema.extend({
  status: z.enum(ALERT_STATUSES).optional(),
  kind: z.enum(ALERT_KINDS).optional(),
  locationId: uuidSchema.optional(),
  productId: uuidSchema.optional(),
});
export type ListAlertsQuery = z.output<typeof listAlertsQuerySchema>;

export interface Alert {
  id: string;
  kind: AlertKind;
  severity: 'MEDIUM' | 'HIGH';
  status: AlertStatus;
  message: string;
  productId: string;
  sku: string;
  productName: string;
  locationId: string;
  locationCode: string;
  /** The inputs the alert was raised from (available, on hand, reserved, pack size, event). */
  details: Record<string, unknown>;
  createdAt: Date;
  resolvedAt: Date | null;
}

export interface SyncAlertInput {
  productId: string;
  locationId: string;
  state: StockState;
  message: string;
  details: Record<string, unknown>;
  eventId: string | null;
}
