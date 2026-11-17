import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';
import { containsPattern } from '../../core/database/sql';
import { offsetOf } from '../../core/http/query';
import type {
  LedgerEntry,
  LedgerQuery,
  LocationStockQuery,
  LocationStockRow,
  ProductStockRow,
} from './inventory.schemas';

/**
 * Read side of inventory. Writes (Day 3) go through InventoryService.applyMovement(), which
 * inserts ledger rows; the database trigger updates balances (see migration 0002).
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
     WHERE b.location_id = $1
       AND ($2::text IS NULL OR p.sku ILIKE $2 OR p.name ILIKE $2)`;
    const filter = [locationId, containsPattern(q.q)];

    const [rows, count] = await Promise.all([
      this.db.query<LocationStockRow>(
        `SELECT p.id AS "productId", p.sku, p.name, p.pack_size AS "packSize",
                b.on_hand AS "onHand", b.reserved,
                (b.on_hand - b.reserved) AS available,
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
  async stockForProduct(productId: string): Promise<ProductStockRow[]> {
    const { rows } = await this.db.query<ProductStockRow>(
      `SELECT l.id AS "locationId", l.code AS "locationCode", l.name AS "locationName",
              l.type AS "locationType",
              b.on_hand AS "onHand", b.reserved,
              (b.on_hand - b.reserved) AS available,
              b.updated_at AS "updatedAt"
         FROM inventory_balances b
         JOIN locations l ON l.id = b.location_id
        WHERE b.product_id = $1
        ORDER BY l.type DESC, l.code`,
      [productId],
    );
    return rows;
  }

  async ledgerForProduct(
    productId: string,
    q: LedgerQuery,
  ): Promise<{ rows: LedgerEntry[]; total: number }> {
    const where = `
      FROM inventory_ledger e
      JOIN locations l ON l.id = e.location_id
     WHERE e.product_id = $1
       AND ($2::uuid IS NULL OR e.location_id = $2)
       AND ($3::movement_type IS NULL OR e.movement_type = $3)`;
    const filter = [productId, q.locationId ?? null, q.movementType ?? null];

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
          LIMIT $4 OFFSET $5`,
        [...filter, q.pageSize, offsetOf(q)],
      ),
      this.db.query<{ total: number }>(`SELECT COUNT(*)::int AS total ${where}`, filter),
    ]);
    return { rows: rows.rows, total: count.rows[0].total };
  }
}
