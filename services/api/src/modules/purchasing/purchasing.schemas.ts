import { z } from 'zod';
import { paginationSchema, uuidSchema } from '../../core/http/query';

export const PO_STATUSES = ['APPROVED', 'RECEIVED', 'CANCELLED'] as const;
export type PoStatus = (typeof PO_STATUSES)[number];

export const listPurchaseOrdersQuerySchema = paginationSchema.extend({
  status: z.enum(PO_STATUSES).optional(),
  locationId: uuidSchema.optional(),
  productId: uuidSchema.optional(),
});
export type ListPurchaseOrdersQuery = z.output<typeof listPurchaseOrdersQuerySchema>;

export interface PurchaseOrderLine {
  productId: string;
  sku: string;
  name: string;
  quantity: number;
  /** Supplier cost per unit at the time of ordering, decimal string. */
  unitCost: string;
}

export interface PurchaseOrderSummary {
  id: string;
  status: PoStatus;
  supplierId: string;
  supplierName: string;
  destinationLocationId: string;
  destinationCode: string;
  /** Date the supplier is expected to deliver (YYYY-MM-DD). */
  expectedDate: string;
  notes: string | null;
  lineCount: number;
  totalUnits: number;
  totalCost: string;
  createdBy: string;
  createdAt: Date;
  receivedBy: string | null;
  receivedAt: Date | null;
  cancelledBy: string | null;
  cancelledAt: Date | null;
}

export interface PurchaseOrderDetail extends PurchaseOrderSummary {
  lines: PurchaseOrderLine[];
}

export interface NewPurchaseOrder {
  supplierId: string;
  destinationLocationId: string;
  expectedInDays: number;
  notes?: string;
  lines: { productId: string; quantity: number; unitCost: number }[];
}
