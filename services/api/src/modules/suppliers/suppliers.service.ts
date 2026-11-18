import { Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { accessibleLocationIds } from '../../core/auth/access';
import type { AuthUser } from '../../core/auth/auth.types';
import { type DeliveryRow, SuppliersRepository } from './suppliers.repository';
import { MIN_DELIVERIES, type ScoredStats, score } from './suppliers.score';

export interface SupplierPerformance extends ScoredStats {
  id: string;
  code: string;
  name: string;
  products: number;
  /** How many of the deliveries are synthetic history (vs received purchase orders). */
  synthetic: number;
  lastDelivery: string | null;
}

export interface SupplierDetail extends SupplierPerformance {
  productStats: (ScoredStats & {
    productId: string;
    sku: string;
    productName: string;
    promisedDays: number | null;
  })[];
  recent: DeliveryRow[];
  rules: { minDeliveries: number; score: string };
}

const SCORE_RULE = '50 × on-time rate + 30 × fill rate + 20 × (1 − lead-time variation, at most 1)';

/**
 * Supplier performance from deliveries (V2 step 2c): lead time, on-time and fill rate, and a
 * documented reliability score. Statistics only — no ML (decision D6). Read-only for everyone.
 */
@Injectable()
export class SuppliersService {
  constructor(private readonly repo: SuppliersRepository) {}

  async list(): Promise<SupplierPerformance[]> {
    const rows = await this.repo.suppliers();
    return rows.map(({ id, code, name, products, synthetic, lastDelivery, ...stats }) => ({
      id,
      code,
      name,
      products,
      synthetic,
      lastDelivery,
      ...score(stats),
    }));
  }

  async get(id: string, user: AuthUser): Promise<SupplierDetail> {
    const row = await this.repo.supplier(id);
    if (!row) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Supplier not found.' });
    }
    const { code, name, products, synthetic, lastDelivery, ...stats } = row;
    const [perProduct, recent] = await Promise.all([
      this.repo.products(id),
      this.repo.recent(id, accessibleLocationIds(user)),
    ]);
    return {
      id,
      code,
      name,
      products,
      synthetic,
      lastDelivery,
      ...score(stats),
      productStats: perProduct.map(({ productId, sku, productName, promisedDays, ...s }) => ({
        productId,
        sku,
        productName,
        promisedDays,
        ...score(s),
      })),
      recent,
      rules: { minDeliveries: MIN_DELIVERIES, score: SCORE_RULE },
    };
  }

  /** For the purchasing module: record the deliveries of a received purchase order. */
  recordOrderDelivery(client: PoolClient, purchaseOrderId: string): Promise<void> {
    return this.repo.recordOrderDelivery(client, purchaseOrderId);
  }
}
