import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../core/database/database.service';
import { offsetOf } from '../../core/http/query';
import type {
  ListPurchaseOrdersQuery,
  NewPurchaseOrder,
  PoStatus,
  PurchaseOrderDetail,
  PurchaseOrderLine,
  PurchaseOrderSummary,
} from './purchasing.schemas';

const SELECT = `
  SELECT po.id, po.status, po.supplier_id AS "supplierId", s.name AS "supplierName",
         po.destination_location_id AS "destinationLocationId", l.code::text AS "destinationCode",
         po.expected_date::text AS "expectedDate", po.notes,
         agg.line_count AS "lineCount", agg.total_units AS "totalUnits", agg.total_cost AS "totalCost",
         cu.display_name AS "createdBy", po.created_at AS "createdAt",
         ru.display_name AS "receivedBy", po.received_at AS "receivedAt",
         xu.display_name AS "cancelledBy", po.cancelled_at AS "cancelledAt"
    FROM purchase_orders po
    JOIN suppliers s ON s.id = po.supplier_id
    JOIN locations l ON l.id = po.destination_location_id
    JOIN users cu ON cu.id = po.created_by
    LEFT JOIN users ru ON ru.id = po.received_by
    LEFT JOIN users xu ON xu.id = po.cancelled_by
    CROSS JOIN LATERAL (
      SELECT COUNT(*)::int AS line_count, COALESCE(SUM(quantity), 0)::int AS total_units,
             COALESCE(SUM(quantity * unit_cost), 0)::numeric(14, 2)::text AS total_cost
        FROM purchase_order_lines WHERE purchase_order_id = po.id
    ) agg`;

const FILTER = `
  WHERE ($1::po_status IS NULL OR po.status = $1)
    AND ($2::uuid IS NULL OR po.destination_location_id = $2)
    AND ($3::uuid IS NULL OR EXISTS (
          SELECT 1 FROM purchase_order_lines x WHERE x.purchase_order_id = po.id AND x.product_id = $3))
    AND ($4::uuid[] IS NULL OR po.destination_location_id = ANY($4))`;

const TRANSITION_SQL: Record<'RECEIVED' | 'CANCELLED', string> = {
  RECEIVED: `UPDATE purchase_orders SET status = 'RECEIVED', received_by = $2, received_at = now() WHERE id = $1`,
  CANCELLED: `UPDATE purchase_orders SET status = 'CANCELLED', cancelled_by = $2, cancelled_at = now() WHERE id = $1`,
};

/** SQL for purchase orders only. Stock arrives through InventoryService.applyMovement(). */
@Injectable()
export class PurchasingRepository {
  constructor(private readonly db: DatabaseService) {}

  async insert(client: PoolClient, po: NewPurchaseOrder, createdBy: string): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO purchase_orders (supplier_id, destination_location_id, expected_date, notes, created_by)
       VALUES ($1, $2, (now() AT TIME ZONE 'UTC')::date + $3::int, $4, $5) RETURNING id`,
      [po.supplierId, po.destinationLocationId, po.expectedInDays, po.notes ?? null, createdBy],
    );
    const id = rows[0].id;
    await client.query(
      `INSERT INTO purchase_order_lines (purchase_order_id, product_id, quantity, unit_cost)
       SELECT $1, * FROM unnest($2::uuid[], $3::int[], $4::numeric[])`,
      [
        id,
        po.lines.map((l) => l.productId),
        po.lines.map((l) => l.quantity),
        po.lines.map((l) => l.unitCost),
      ],
    );
    return id;
  }

  /** Lock the order so two people cannot receive or cancel it at the same time. */
  async lock(
    client: PoolClient,
    id: string,
  ): Promise<{ status: PoStatus; destinationLocationId: string } | null> {
    const { rows } = await client.query<{ status: PoStatus; destinationLocationId: string }>(
      `SELECT status, destination_location_id AS "destinationLocationId"
         FROM purchase_orders WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return rows[0] ?? null;
  }

  async transition(
    client: PoolClient,
    id: string,
    to: 'RECEIVED' | 'CANCELLED',
    actorId: string,
  ): Promise<void> {
    await client.query(TRANSITION_SQL[to], [id, actorId]);
  }

  async lines(client: PoolClient | null, id: string): Promise<PurchaseOrderLine[]> {
    const sql = `SELECT l.product_id AS "productId", p.sku::text AS sku, p.name, l.quantity,
                        l.unit_cost::text AS "unitCost"
                   FROM purchase_order_lines l JOIN products p ON p.id = l.product_id
                  WHERE l.purchase_order_id = $1 ORDER BY p.sku`;
    const res = client
      ? await client.query<PurchaseOrderLine>(sql, [id])
      : await this.db.query<PurchaseOrderLine>(sql, [id]);
    return res.rows;
  }

  async find(id: string, client?: PoolClient): Promise<PurchaseOrderDetail | null> {
    const sql = `${SELECT} WHERE po.id = $1`;
    const res = client
      ? await client.query<PurchaseOrderSummary>(sql, [id])
      : await this.db.query<PurchaseOrderSummary>(sql, [id]);
    if (res.rows.length === 0) return null;
    return { ...res.rows[0], lines: await this.lines(client ?? null, id) };
  }

  async list(
    q: ListPurchaseOrdersQuery,
    scope: string[] | null,
  ): Promise<{ rows: PurchaseOrderSummary[]; total: number }> {
    const filter = [q.status ?? null, q.locationId ?? null, q.productId ?? null, scope];
    const [rows, count] = await Promise.all([
      this.db.query<PurchaseOrderSummary>(
        `${SELECT} ${FILTER} ORDER BY po.created_at DESC, po.id LIMIT $5 OFFSET $6`,
        [...filter, q.pageSize, offsetOf(q)],
      ),
      this.db.query<{ total: number }>(
        `SELECT COUNT(*)::int AS total FROM purchase_orders po ${FILTER}`,
        filter,
      ),
    ]);
    return { rows: rows.rows, total: count.rows[0].total };
  }
}
