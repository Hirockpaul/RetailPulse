import { z } from 'zod';
import { paginationSchema, searchSchema, sortSchema, uuidSchema } from '../../core/http/query';

// ----- requests

export const listProductsQuerySchema = paginationSchema.extend({
  q: searchSchema,
  categoryId: uuidSchema.optional(),
  sort: sortSchema(
    { sku: 'p.sku', name: 'p.name', price: 'p.unit_price', available: '"totalAvailable"' },
    'sku:asc',
  ),
});
export type ListProductsQuery = z.output<typeof listProductsQuerySchema>;

// ----- responses

export interface ProductSummary {
  id: string;
  sku: string;
  name: string;
  categoryId: string;
  categoryName: string;
  /** Decimal string, e.g. "4.99" — never a float. */
  unitPrice: string;
  packSize: number;
  isActive: boolean;
  /** Sum across all locations. */
  totalOnHand: number;
  totalAvailable: number;
}

export interface PrimarySupplier {
  id: string;
  code: string;
  name: string;
  leadTimeDays: number;
  minOrderQty: number;
  unitCost: string;
}

export interface ProductDetail extends ProductSummary {
  primarySupplier: PrimarySupplier | null;
}

export interface Category {
  id: string;
  name: string;
  productCount: number;
}
