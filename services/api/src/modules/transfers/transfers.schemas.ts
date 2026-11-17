import { z } from 'zod';
import { paginationSchema, uuidSchema } from '../../core/http/query';
import { quantitySchema, uniqueProducts } from '../inventory/inventory.schemas';

export const TRANSFER_STATUSES = [
  'REQUESTED',
  'APPROVED',
  'DISPATCHED',
  'RECEIVED',
  'CANCELLED',
] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export const createTransferBodySchema = z
  .object({
    sourceLocationId: uuidSchema,
    destinationLocationId: uuidSchema,
    notes: z.string().trim().min(1).max(200).optional(),
    lines: z
      .array(z.object({ productId: uuidSchema, quantity: quantitySchema }))
      .min(1)
      .max(100)
      .refine(uniqueProducts, 'Each product may appear only once.'),
  })
  .refine((b) => b.sourceLocationId !== b.destinationLocationId, {
    path: ['destinationLocationId'],
    message: 'Must differ from the source location.',
  });
export type CreateTransferBody = z.output<typeof createTransferBodySchema>;

export const listTransfersQuerySchema = paginationSchema.extend({
  status: z.enum(TRANSFER_STATUSES).optional(),
  /** Matches transfers leaving or arriving at this location. */
  locationId: uuidSchema.optional(),
  productId: uuidSchema.optional(),
});
export type ListTransfersQuery = z.output<typeof listTransfersQuerySchema>;

export interface TransferSummary {
  id: string;
  status: TransferStatus;
  notes: string | null;
  sourceLocationId: string;
  sourceCode: string;
  sourceName: string;
  destinationLocationId: string;
  destinationCode: string;
  destinationName: string;
  lineCount: number;
  totalUnits: number;
  /** Who did each step and when (display names; null until the step happens). */
  requestedBy: string;
  requestedAt: Date;
  approvedBy: string | null;
  approvedAt: Date | null;
  dispatchedBy: string | null;
  dispatchedAt: Date | null;
  receivedBy: string | null;
  receivedAt: Date | null;
  cancelledBy: string | null;
  cancelledAt: Date | null;
}

export interface TransferLine {
  productId: string;
  sku: string;
  name: string;
  quantity: number;
}

export interface TransferDetail extends TransferSummary {
  lines: TransferLine[];
}
