import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../core/database/database.service';
import { offsetOf } from '../../core/http/query';
import type { ListReservationsQuery, Reservation } from './reservations.schemas';

const SELECT = `
  SELECT r.id, r.product_id AS "productId", p.sku::text AS sku,
         r.location_id AS "locationId", l.code::text AS "locationCode",
         r.quantity, r.status, r.reference,
         r.created_at AS "createdAt", r.released_at AS "releasedAt"
    FROM reservations r
    JOIN products p ON p.id = r.product_id
    JOIN locations l ON l.id = r.location_id`;

const FILTER = `
  WHERE ($1::uuid IS NULL OR r.product_id = $1)
    AND ($2::uuid IS NULL OR r.location_id = $2)
    AND ($3::reservation_status IS NULL OR r.status = $3)
    AND ($4::uuid[] IS NULL OR r.location_id = ANY($4))`;

/** SQL for the reservations table only. Reserved quantity itself lives in the inventory ledger. */
@Injectable()
export class ReservationsRepository {
  constructor(private readonly db: DatabaseService) {}

  async insert(
    client: PoolClient,
    r: { id: string; productId: string; locationId: string; quantity: number; reference?: string },
  ): Promise<void> {
    await client.query(
      `INSERT INTO reservations (id, product_id, location_id, quantity, reference)
       VALUES ($1, $2, $3, $4, $5)`,
      [r.id, r.productId, r.locationId, r.quantity, r.reference ?? null],
    );
  }

  /** Lock the reservation row so two concurrent releases cannot both succeed. */
  async lockForUpdate(
    client: PoolClient,
    id: string,
  ): Promise<{ productId: string; locationId: string; quantity: number; status: string } | null> {
    const { rows } = await client.query<{
      productId: string;
      locationId: string;
      quantity: number;
      status: string;
    }>(
      `SELECT product_id AS "productId", location_id AS "locationId", quantity, status
         FROM reservations WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return rows[0] ?? null;
  }

  async markReleased(client: PoolClient, id: string): Promise<void> {
    await client.query(
      `UPDATE reservations SET status = 'RELEASED', released_at = now() WHERE id = $1`,
      [id],
    );
  }

  async find(id: string, client?: PoolClient): Promise<Reservation | null> {
    const sql = `${SELECT} WHERE r.id = $1`;
    const res = client
      ? await client.query<Reservation>(sql, [id])
      : await this.db.query<Reservation>(sql, [id]);
    return res.rows[0] ?? null;
  }

  async list(
    q: ListReservationsQuery,
    scope: string[] | null,
  ): Promise<{ rows: Reservation[]; total: number }> {
    const filter = [q.productId ?? null, q.locationId ?? null, q.status ?? null, scope];
    const [rows, count] = await Promise.all([
      this.db.query<Reservation>(
        `${SELECT} ${FILTER} ORDER BY r.created_at DESC, r.id LIMIT $5 OFFSET $6`,
        [...filter, q.pageSize, offsetOf(q)],
      ),
      this.db.query<{ total: number }>(
        `SELECT COUNT(*)::int AS total FROM reservations r ${FILTER}`,
        filter,
      ),
    ]);
    return { rows: rows.rows, total: count.rows[0].total };
  }
}
