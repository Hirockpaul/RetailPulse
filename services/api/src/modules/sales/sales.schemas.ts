import { z } from 'zod';
import { uuidSchema } from '../../core/http/query';
import { quantitySchema, uniqueProducts } from '../inventory/inventory.schemas';

export const createSaleBodySchema = z.object({
  /** Must be a STORE (sales do not happen at distribution centres). */
  locationId: uuidSchema,
  lines: z
    .array(z.object({ productId: uuidSchema, quantity: quantitySchema }))
    .min(1)
    .max(50)
    .refine(uniqueProducts, 'Each product may appear only once.'),
});
export type CreateSaleBody = z.output<typeof createSaleBodySchema>;

export interface SalesOrderLine {
  productId: string;
  sku: string;
  quantity: number;
  /** Price at the time of sale, decimal string. */
  unitPrice: string;
}

export interface SalesOrder {
  id: string;
  locationId: string;
  /** Decimal string, e.g. "17.48". */
  totalAmount: string;
  createdAt: Date;
  lines: SalesOrderLine[];
}
