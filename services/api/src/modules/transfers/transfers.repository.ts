import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../core/database/database.service';
import { offsetOf } from '../../core/http/query';
import type {
  ListTransfersQuery,
  TransferDetail,
  TransferLine,
  TransferStatus,
  TransferSummary,
} from './transfers.schemas';

const SELECT = `
  SELECT t.id, t.status, t.notes,
         t.source_location_id AS "sourceLocationId",
         s.code::text AS "sourceCode", s.name AS "sourceName",
         t.destination_location_id AS "destinationLocationId",
         d.code::text AS "destinationCode", d.name AS "destinationName",
         agg.line_count AS "lineCount", agg.total_units AS "totalUnits",
         ru.display_name AS "requestedBy", t.requested_at AS "requestedAt",
         au.display_name AS "approvedBy", t.approved_at AS "approvedAt",
         du.display_name AS "dispatchedBy", t.dispatched_at AS "dispatchedAt",
         eu.display_name AS "receivedBy", t.received_at AS "receivedAt",
         cu.display_name AS "cancelledBy", t.cancelled_at AS "cancelledAt"
    FROM stock_transfers t
    JOIN locations s ON s.id = t.source_location_id
    JOIN locations d ON d.id = t.destination_location_id
    JOIN users ru ON ru.id = t.requested_by
    LEFT JOIN users au ON au.id = t.approved_by
    LEFT JOIN users du ON du.id = t.dispatched_by
    LEFT JOIN users eu ON eu.id = t.received_by
    LEFT JOIN users cu ON cu.id = t.cancelled_by
    CROSS JOIN LATERAL (
      SELECT COUNT(*)::int AS line_count, COALESCE(SUM(quantity), 0)::int AS total_units
        FROM stock_transfer_lines WHERE transfer_id = t.id
    ) agg`;

const FILTER = `
  WHERE ($1::transfer_status IS NULL OR t.status = $1)
    AND ($2::uuid IS NULL OR t.source_location_id = $2 OR t.destination_location_id = $2)
    AND ($3::uuid IS NULL OR EXISTS (
          SELECT 1 FROM stock_transfer_lines x WHERE x.transfer_id = t.id AND x.product_id = $3))
    AND ($4::uuid[] IS NULL OR t.source_location_id = ANY($4)
                            OR t.destination_location_id = ANY($4))`;

/** Which columns record who/when for each status change. */
const TRANSITION_SQL: Record<Exclude<TransferStatus, 'REQUESTED'>, string> = {
  APPROVED: `UPDATE stock_transfers SET status = 'APPROVED', approved_by = $2, approved_at = now() WHERE id = $1`,
  DISPATCHED: `UPDATE stock_transfers SET status = 'DISPATCHED', dispatched_by = $2, dispatched_at = now() WHERE id = $1`,
  RECEIVED: `UPDATE stock_transfers SET status = 'RECEIVED', received_by = $2, received_at = now() WHERE id = $1`,
  CANCELLED: `UPDATE stock_transfers SET status = 'CANCELLED', cancelled_by = $2, cancelled_at = now() WHERE id = $1`,
};

export interface LockedTransfer {
  status: TransferStatus;
  sourceLocationId: string;
  destinationLocationId: string;
}

/** SQL for transfer documents only. Stock moves through InventoryService.applyMovement(). */
@Injectable()
export class TransfersRepository {
  constructor(private readonly db: DatabaseService) {}

  async insert(
    client: PoolClient,
    t: { sourceLocationId: string; destinationLocationId: string; notes?: string },
    requestedBy: string,
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO stock_transfers (source_location_id, destination_location_id, notes, requested_by)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [t.sourceLocationId, t.destinationLocationId, t.notes ?? null, requestedBy],
    );
    return rows[0].id;
  }

  async insertLines(
    client: PoolClient,
    transferId: string,
    lines: { productId: string; quantity: number }[],
  ): Promise<void> {
    await client.query(
      `INSERT INTO stock_transfer_lines (transfer_id, product_id, quantity)
       SELECT $1, * FROM unnest($2::uuid[], $3::int[])`,
      [transferId, lines.map((l) => l.productId), lines.map((l) => l.quantity)],
    );
  }

  /** Lock the transfer row: concurrent approve/dispatch/receive on one transfer serialize. */
  async lock(client: PoolClient, id: string): Promise<LockedTransfer | null> {
    const { rows } = await client.query<LockedTransfer>(
      `SELECT status, source_location_id AS "sourceLocationId",
              destination_location_id AS "destinationLocationId"
         FROM stock_transfers WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return rows[0] ?? null;
  }

  async transition(
    client: PoolClient,
    id: string,
    to: Exclude<TransferStatus, 'REQUESTED'>,
    actorId: string,
  ): Promise<void> {
    await client.query(TRANSITION_SQL[to], [id, actorId]);
  }

  async lines(client: PoolClient | null, id: string): Promise<TransferLine[]> {
    const sql = `SELECT l.product_id AS "productId", p.sku::text AS sku, p.name, l.quantity
                   FROM stock_transfer_lines l JOIN products p ON p.id = l.product_id
                  WHERE l.transfer_id = $1 ORDER BY p.sku`;
    const res = client
      ? await client.query<TransferLine>(sql, [id])
      : await this.db.query<TransferLine>(sql, [id]);
    return res.rows;
  }

  async find(id: string, client?: PoolClient): Promise<TransferDetail | null> {
    const sql = `${SELECT} WHERE t.id = $1`;
    const res = client
      ? await client.query<TransferSummary>(sql, [id])
      : await this.db.query<TransferSummary>(sql, [id]);
    if (res.rows.length === 0) return null;
    return { ...res.rows[0], lines: await this.lines(client ?? null, id) };
  }

  async list(
    q: ListTransfersQuery,
    scope: string[] | null,
  ): Promise<{ rows: TransferSummary[]; total: number }> {
    const filter = [q.status ?? null, q.locationId ?? null, q.productId ?? null, scope];
    const [rows, count] = await Promise.all([
      this.db.query<TransferSummary>(
        `${SELECT} ${FILTER} ORDER BY t.requested_at DESC, t.id LIMIT $5 OFFSET $6`,
        [...filter, q.pageSize, offsetOf(q)],
      ),
      this.db.query<{ total: number }>(
        `SELECT COUNT(*)::int AS total FROM stock_transfers t ${FILTER}`,
        filter,
      ),
    ]);
    return { rows: rows.rows, total: count.rows[0].total };
  }
}
