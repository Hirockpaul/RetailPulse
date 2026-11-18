import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../core/database/database.service';
import type { DeliveryStats } from './suppliers.score';

/** Lead time = days from order to receipt; on time = no later than the promised lead time. */
const STATS = `
  COUNT(*)::int AS deliveries,
  AVG(d.received_on - d.ordered_on)::float8 AS "meanLeadDays",
  (percentile_cont(0.5) WITHIN GROUP (ORDER BY d.received_on - d.ordered_on))::float8 AS "medianLeadDays",
  STDDEV_POP(d.received_on - d.ordered_on)::float8 AS "stdLeadDays",
  AVG(((d.received_on - d.ordered_on) <= d.promised_days)::int)::float8 AS "onTimeRate",
  AVG(((d.received_on - d.ordered_on) > d.promised_days)::int)::float8 AS "lateRate",
  (AVG((d.received_on - d.ordered_on) - d.promised_days)
     FILTER (WHERE (d.received_on - d.ordered_on) > d.promised_days))::float8 AS "avgDaysLate",
  (SUM(d.received_qty)::float8 / NULLIF(SUM(d.ordered_qty), 0)) AS "fillRate",
  AVG(d.promised_days)::float8 AS "meanPromisedDays"`;

export interface SupplierRow extends DeliveryStats {
  id: string;
  code: string;
  name: string;
  products: number;
  synthetic: number;
  lastDelivery: string | null;
}

export interface ProductRow extends DeliveryStats {
  productId: string;
  sku: string;
  productName: string;
  /** Lead time the supplier currently promises for this product (supplier terms). */
  promisedDays: number | null;
}

export interface DeliveryRow {
  orderedOn: string;
  receivedOn: string;
  promisedDays: number;
  leadDays: number;
  orderedQty: number;
  receivedQty: number;
  sku: string;
  locationCode: string;
  source: 'SYNTHETIC' | 'ORDER';
}

@Injectable()
export class SuppliersRepository {
  constructor(private readonly db: DatabaseService) {}

  async suppliers(): Promise<SupplierRow[]> {
    const { rows } = await this.db.query<SupplierRow>(
      `SELECT s.id, s.code::text AS code, s.name,
              (SELECT COUNT(*)::int FROM supplier_products sp WHERE sp.supplier_id = s.id AND sp.is_primary)
                AS products,
              COUNT(d.id) FILTER (WHERE d.source = 'SYNTHETIC')::int AS synthetic,
              MAX(d.received_on)::text AS "lastDelivery",
              ${STATS}
         FROM suppliers s LEFT JOIN supplier_deliveries d ON d.supplier_id = s.id
        GROUP BY s.id ORDER BY s.code`,
    );
    return rows;
  }

  async supplier(id: string): Promise<SupplierRow | null> {
    const { rows } = await this.db.query<SupplierRow>(
      `SELECT s.id, s.code::text AS code, s.name,
              (SELECT COUNT(*)::int FROM supplier_products sp WHERE sp.supplier_id = s.id AND sp.is_primary)
                AS products,
              COUNT(d.id) FILTER (WHERE d.source = 'SYNTHETIC')::int AS synthetic,
              MAX(d.received_on)::text AS "lastDelivery",
              ${STATS}
         FROM suppliers s LEFT JOIN supplier_deliveries d ON d.supplier_id = s.id
        WHERE s.id = $1 GROUP BY s.id`,
      [id],
    );
    return rows[0] ?? null;
  }

  async products(supplierId: string): Promise<ProductRow[]> {
    const { rows } = await this.db.query<ProductRow>(
      `SELECT p.id AS "productId", p.sku::text AS sku, p.name AS "productName",
              (SELECT sp.lead_time_days FROM supplier_products sp
                WHERE sp.supplier_id = $1 AND sp.product_id = p.id) AS "promisedDays",
              ${STATS}
         FROM supplier_deliveries d JOIN products p ON p.id = d.product_id
        WHERE d.supplier_id = $1
        GROUP BY p.id ORDER BY p.sku`,
      [supplierId],
    );
    return rows;
  }

  /** Newest deliveries; `locationIds` limits store managers to their own stores. */
  async recent(
    supplierId: string,
    locationIds: string[] | null,
    limit = 20,
  ): Promise<DeliveryRow[]> {
    const { rows } = await this.db.query<DeliveryRow>(
      `SELECT d.ordered_on::text AS "orderedOn", d.received_on::text AS "receivedOn",
              d.promised_days AS "promisedDays", (d.received_on - d.ordered_on) AS "leadDays",
              d.ordered_qty AS "orderedQty", d.received_qty AS "receivedQty",
              p.sku::text AS sku, l.code::text AS "locationCode", d.source
         FROM supplier_deliveries d
         JOIN products p ON p.id = d.product_id
         JOIN locations l ON l.id = d.location_id
        WHERE d.supplier_id = $1 AND ($2::uuid[] IS NULL OR d.location_id = ANY($2))
        ORDER BY d.received_on DESC, d.created_at DESC
        LIMIT $3`,
      [supplierId, locationIds, limit],
    );
    return rows;
  }

  /**
   * A purchase order was received: one delivery row per line, in the receipt's transaction.
   * Lead time promised = expected date − order date; the whole quantity arrives (the system has
   * no partial receipts yet).
   */
  async recordOrderDelivery(client: PoolClient, purchaseOrderId: string): Promise<void> {
    await client.query(
      `INSERT INTO supplier_deliveries (supplier_id, product_id, location_id, ordered_on,
          promised_days, received_on, ordered_qty, received_qty, source, purchase_order_id)
       SELECT po.supplier_id, l.product_id, po.destination_location_id,
              (po.created_at AT TIME ZONE 'UTC')::date,
              GREATEST(po.expected_date - (po.created_at AT TIME ZONE 'UTC')::date, 0),
              GREATEST((now() AT TIME ZONE 'UTC')::date, (po.created_at AT TIME ZONE 'UTC')::date),
              l.quantity, l.quantity, 'ORDER', po.id
         FROM purchase_orders po JOIN purchase_order_lines l ON l.purchase_order_id = po.id
        WHERE po.id = $1
       ON CONFLICT DO NOTHING`,
      [purchaseOrderId],
    );
  }
}
