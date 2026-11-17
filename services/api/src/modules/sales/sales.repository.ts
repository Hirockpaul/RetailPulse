import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../core/database/database.service';
import type { SalesOrder, SalesOrderLine } from './sales.schemas';

interface OrderRow {
  id: string;
  locationId: string;
  totalAmount: string;
  createdAt: Date;
}

/** SQL for sales documents only. Stock is never touched here (see InventoryService). */
@Injectable()
export class SalesRepository {
  constructor(private readonly db: DatabaseService) {}

  /** Which requested products are unknown or inactive? Run inside the sale's transaction. */
  async checkProducts(
    client: PoolClient,
    productIds: string[],
  ): Promise<{ missing: string[]; inactive: string[] }> {
    const { rows } = await client.query<{ id: string; is_active: boolean }>(
      'SELECT id, is_active FROM products WHERE id = ANY($1::uuid[])',
      [productIds],
    );
    const found = new Map(rows.map((r) => [r.id, r.is_active]));
    return {
      missing: productIds.filter((id) => !found.has(id)),
      inactive: productIds.filter((id) => found.get(id) === false),
    };
  }

  /** Insert the order and its lines (prices snapshotted from the catalog) and set the total. */
  async createOrder(
    client: PoolClient,
    input: { locationId: string; lines: { productId: string; quantity: number }[] },
    correlationId: string | undefined,
  ): Promise<SalesOrder> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO sales_orders (location_id, correlation_id) VALUES ($1, $2) RETURNING id`,
      [input.locationId, correlationId ?? null],
    );
    const orderId = rows[0].id;

    await client.query(
      `INSERT INTO sales_order_lines (order_id, product_id, quantity, unit_price)
       SELECT $1, l.product_id, l.quantity, p.unit_price
         FROM unnest($2::uuid[], $3::int[]) AS l(product_id, quantity)
         JOIN products p ON p.id = l.product_id`,
      [orderId, input.lines.map((l) => l.productId), input.lines.map((l) => l.quantity)],
    );
    await client.query(
      `UPDATE sales_orders
          SET total_amount = (SELECT COALESCE(SUM(quantity * unit_price), 0)
                                FROM sales_order_lines WHERE order_id = $1)
        WHERE id = $1`,
      [orderId],
    );

    const order = await this.findOrder(orderId, client);
    if (!order) throw new Error('Sales order vanished inside its own transaction.');
    return order;
  }

  async findOrder(id: string, client?: PoolClient): Promise<SalesOrder | null> {
    const run = <T extends object>(sql: string, params: unknown[]) =>
      client ? client.query<T>(sql, params) : this.db.query<T>(sql, params);

    const order = await run<OrderRow>(
      `SELECT id, location_id AS "locationId", total_amount::text AS "totalAmount",
              created_at AS "createdAt"
         FROM sales_orders WHERE id = $1`,
      [id],
    );
    if (order.rows.length === 0) return null;

    const lines = await run<SalesOrderLine>(
      `SELECT l.product_id AS "productId", p.sku::text AS sku, l.quantity,
              l.unit_price::text AS "unitPrice"
         FROM sales_order_lines l JOIN products p ON p.id = l.product_id
        WHERE l.order_id = $1
        ORDER BY p.sku`,
      [id],
    );
    return { ...order.rows[0], lines: lines.rows };
  }
}
