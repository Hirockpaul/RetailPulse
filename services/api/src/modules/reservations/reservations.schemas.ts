import { z } from 'zod';
import { paginationSchema, uuidSchema } from '../../core/http/query';
import { quantitySchema } from '../inventory/inventory.schemas';

export const RESERVATION_STATUSES = ['ACTIVE', 'RELEASED'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export const createReservationBodySchema = z.object({
  productId: uuidSchema,
  locationId: uuidSchema,
  quantity: quantitySchema,
  /** Free-text reason or document, e.g. a click-and-collect order number. */
  reference: z.string().trim().min(1).max(100).optional(),
});
export type CreateReservationBody = z.output<typeof createReservationBodySchema>;

export const listReservationsQuerySchema = paginationSchema.extend({
  productId: uuidSchema.optional(),
  locationId: uuidSchema.optional(),
  status: z.enum(RESERVATION_STATUSES).optional(),
});
export type ListReservationsQuery = z.output<typeof listReservationsQuerySchema>;

export interface Reservation {
  id: string;
  productId: string;
  sku: string;
  locationId: string;
  locationCode: string;
  quantity: number;
  status: ReservationStatus;
  reference: string | null;
  createdAt: Date;
  releasedAt: Date | null;
}
