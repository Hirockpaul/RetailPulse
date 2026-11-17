import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../core/database/database.service';
import { containsPattern } from '../../core/database/sql';
import { offsetOf } from '../../core/http/query';
import type {
  LedgerEntry,
  LedgerQuery,
  LocationStockQuery,
  LocationStockRow,
  Movement,
  MovementResult,
  ProductStockRow,
  StockPosition,
} from './inventory.schemas';

/**
 * Units expected at this balance's location: approved / dispatched transfers plus approved
 * (not yet received) purchase orders. Derived on every read, never stored.
 */
const INBOUND_JOIN = `
  LEFT JOIN LATERAL (
    SELECT (
      COALESCE((SELECT SUM(tl.quantity)
                  FROM stock_transfer_lines tl
                  JOIN stock_transfers t ON t.id = tl.transfer_id
                 WHERE tl.product_id = b.product_id
                   AND t.destination_location_id = b.location_id
                   AND t.status IN ('APPROVED', 'DISPATCHED')), 0)
      + COALESCE((SELECT SUM(pl.quantity)
                    FROM purchase_order_lines pl
                    JOIN purchase_orders po ON po.id = pl.purchase_order_id
                   WHERE pl.product_id = b.product_id
                     AND po.destination_location_id = b.location_id
                     AND po.status = 'APPROVED'), 0)
    )::int AS inbound
  ) i ON true`;

/**
 * Inventory SQL. Reads accept an optional `scope` (allowed location ids, or null for all) so
 * store managers only ever receive rows for their own stores. Writes go through
 * InventoryService.applyMovement(), which inserts ledger rows; the database trigger updates
 * balances (see migration 0002).
 */
@Injectable()
export class InventoryRepository {
  constructor(private readonly db: DatabaseService) {}

  async stockAtLocation(
    locationId: string,
    q: LocationStockQuery,
  ): Promise<{ rows: LocationStockRow[]; total: number }> {
    const where = `
      FROM inventory_balances b
      JOIN products p ON p.id = b.product_id
      ${INBOUND_JOIN}
     WHERE b.location_id = $1
       AND ($2::text IS NULL OR p.sku ILIKE $2 OR p.name ILIKE $2)`;
    const filter = [locationId, containsPattern(q.q)];

    const [rows, count] = await Promise.all([
      this.db.query<LocationStockRow>(
        `SELECT p.id AS "productId", p.sku, p.name, p.pack_size AS "packSize",
                b.on_hand AS "onHand", b.reserved,
                (b.on_hand - b.reserved) AS available,
                i.inbound,
                b.updated_at AS "updatedAt"
           ${where}
          ORDER BY ${q.sort}, p.id
          LIMIT $3 OFFSET $4`,
        [...filter, q.pageSize, offsetOf(q)],
      ),
      this.db.query<{ total: number }>(`SELECT COUNT(*)::int AS total ${where}`, filter),
    ]);
    return { rows: rows.rows, total: count.rows[0].total };
  }

  /** Bounded by the number of locations (a handful), so not paginated. */
  async stockForProduct(productId: string, scope: string[] | null): Promise<ProductStockRow[]> {
    const { rows } = await this.db.query<ProductStockRow>(
      `SELECT l.id AS "locationId", l.code AS "locationCode", l.name AS "locationName",
              l.type AS "locationType",
              b.on_hand AS "onHand", b.reserved,
              (b.on_hand - b.reserved) AS available,
              i.inbound,
              b.updated_at AS "updatedAt"
         FROM inventory_balances b
         JOIN locations l ON l.id = b.location_id
         ${INBOUND_JOIN}
        WHERE b.product_id = $1
          AND ($2::uuid[] IS NULL OR b.location_id = ANY($2))
        ORDER BY l.type DESC, l.code`,
      [productId, scope],
    );
    return rows;
  }

  async ledgerForProduct(
    productId: string,
    q: LedgerQuery,
    scope: string[] | null,
  ): Promise<{ rows: LedgerEntry[]; total: number }> {
    const where = `
      FROM inventory_ledger e
      JOIN locations l ON l.id = e.location_id
     WHERE e.product_id = $1
       AND ($2::uuid IS NULL OR e.location_id = $2)
       AND ($3::movement_type IS NULL OR e.movement_type = $3)
       AND ($4::uuid[] IS NULL OR e.location_id = ANY($4))`;
    const filter = [productId, q.locationId ?? null, q.movementType ?? null, scope];

    const [rows, count] = await Promise.all([
      this.db.query<LedgerEntry>(
        `SELECT e.id::text AS id, e.location_id AS "locationId", l.code AS "locationCode",
                e.movement_type AS "movementType",
                e.on_hand_delta AS "onHandDelta", e.reserved_delta AS "reservedDelta",
                e.on_hand_after AS "onHandAfter", e.reserved_after AS "reservedAfter",
                e.reason, e.reference_type AS "referenceType", e.reference_id AS "referenceId",
                e.occurred_at AS "occurredAt"
           ${where}
          ORDER BY e.id DESC
          LIMIT $5 OFFSET $6`,
        [...filter, q.pageSize, offsetOf(q)],
      ),
      this.db.query<{ total: number }>(`SELECT COUNT(*)::int AS total ${where}`, filter),
    ]);
    return { rows: rows.rows, total: count.rows[0].total };
  }

  /**
   * Insert one ledger row inside the caller's transaction. The database trigger applies it to
   * the balance (row-locked) and fills in the after-values; CHECK constraints reject oversell.
   */
  async insertLedgerEntry(client: PoolClient, m: Movement): Promise<MovementResult> {
    const { rows } = await client.query<MovementResult>(
      `INSERT INTO inventory_ledger
         (product_id, location_id, movement_type, on_hand_delta, reserved_delta,
          reason, reference_type, reference_id, correlation_id, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id::text AS "ledgerId", product_id AS "productId", location_id AS "locationId",
                 movement_type AS "movementType", on_hand_delta AS "onHandDelta",
                 reserved_delta AS "reservedDelta", on_hand_after AS "onHandAfter",
                 reserved_after AS "reservedAfter", occurred_at AS "occurredAt"`,
      [
        m.productId,
        m.locationId,
        m.type,
        m.onHandDelta,
        m.reservedDelta ?? 0,
        m.reason ?? null,
        m.referenceType ?? null,
        m.referenceId ?? null,
        m.correlationId ?? null,
        m.actorId ?? null,
      ],
    );
    return rows[0];
  }

  /** Current on-hand / reserved for a pair (zero if never stocked); null if either id is unknown. */
  async stockPosition(
    client: PoolClient,
    productId: string,
    locationId: string,
  ): Promise<StockPosition | null> {
    const { rows } = await client.query<StockPosition>(
      `SELECT p.id AS "productId", l.id AS "locationId", p.sku::text AS sku,
              p.name AS "productName", p.pack_size AS "packSize", l.code::text AS "locationCode",
              COALESCE(b.on_hand, 0) AS "onHand", COALESCE(b.reserved, 0) AS reserved,
              COALESCE(b.on_hand - b.reserved, 0) AS available
         FROM products p
         CROSS JOIN locations l
         LEFT JOIN inventory_balances b ON b.product_id = p.id AND b.location_id = l.id
        WHERE p.id = $1 AND l.id = $2`,
      [productId, locationId],
    );
    return rows[0] ?? null;
  }
}
