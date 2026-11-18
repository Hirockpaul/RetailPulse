import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../core/database/database.service';
import { offsetOf } from '../../core/http/query';
import type { RuleFinding } from './anomalies.rules';
import type {
  AnomalyFinding,
  AnomalyStatus,
  ListAnomaliesQuery,
  ReviewEvent,
} from './anomalies.schemas';

const SELECT = `
  SELECT f.id, f.source, f.kind, f.severity, f.status::text AS status, f.day::text AS day,
         f.product_id AS "productId", p.sku::text AS sku, p.name AS "productName",
         f.location_id AS "locationId", l.code::text AS "locationCode",
         f.score::float8 AS score, f.observed::float8 AS observed, f.expected::float8 AS expected,
         f.explanation, f.details, f.rule, f.found_at AS "foundAt", f.reviewed_at AS "reviewedAt"
    FROM anomaly_findings f
    JOIN products p ON p.id = f.product_id
    JOIN locations l ON l.id = f.location_id`;

const FILTER = `
  WHERE ($1::text IS NULL OR f.status::text = $1
         OR ($1 = 'OPEN' AND f.status IN ('NEW', 'INVESTIGATING')))
    AND ($2::text IS NULL OR f.severity = $2)
    AND ($3::text IS NULL OR f.source = $3)
    AND ($4::text IS NULL OR f.kind = $4)
    AND ($5::uuid IS NULL OR f.location_id = $5)
    AND ($6::uuid IS NULL OR f.product_id = $6)
    AND ($7::uuid[] IS NULL OR f.location_id = ANY($7))`;

/** SQL for findings and their reviews. Reads the ledger (read-only) for the operational rules. */
@Injectable()
export class AnomaliesRepository {
  constructor(private readonly db: DatabaseService) {}

  async list(
    q: ListAnomaliesQuery,
    locationIds: string[] | null,
  ): Promise<{ rows: AnomalyFinding[]; total: number }> {
    const params = [
      q.status ?? null,
      q.severity ?? null,
      q.source ?? null,
      q.kind ?? null,
      q.locationId ?? null,
      q.productId ?? null,
      locationIds,
    ];
    const [rows, count] = await Promise.all([
      this.db.query<AnomalyFinding>(
        `${SELECT} ${FILTER}
          ORDER BY ${q.sort}, f.day DESC, f.score DESC, f.id
          LIMIT $8 OFFSET $9`,
        [...params, q.pageSize, offsetOf(q)],
      ),
      this.db.query<{ total: number }>(
        `SELECT COUNT(*)::int AS total FROM anomaly_findings f ${FILTER}`,
        params,
      ),
    ]);
    return { rows: rows.rows, total: count.rows[0].total };
  }

  async find(id: string): Promise<AnomalyFinding | null> {
    const { rows } = await this.db.query<AnomalyFinding>(`${SELECT} WHERE f.id = $1`, [id]);
    return rows[0] ?? null;
  }

  async history(id: string): Promise<ReviewEvent[]> {
    const { rows } = await this.db.query<ReviewEvent>(
      `SELECT e.from_status::text AS "fromStatus", e.to_status::text AS "toStatus", e.note,
              u.display_name AS actor, e.at
         FROM anomaly_review_events e
         JOIN anomaly_reviews r ON r.id = e.review_id
         JOIN users u ON u.id = e.actor_id
        WHERE r.sales_detection_id = $1 OR r.operational_anomaly_id = $1
        ORDER BY e.id`,
      [id],
    );
    return rows;
  }

  /** The review row of a finding, locked for this transaction; null while the finding is NEW. */
  async lockReview(
    client: PoolClient,
    findingId: string,
  ): Promise<{ id: string; status: AnomalyStatus } | null> {
    const { rows } = await client.query<{ id: string; status: AnomalyStatus }>(
      `SELECT id, status::text AS status FROM anomaly_reviews
        WHERE sales_detection_id = $1 OR operational_anomaly_id = $1
        FOR UPDATE`,
      [findingId],
    );
    return rows[0] ?? null;
  }

  /** First decision. Two people deciding at once: the second INSERT hits the unique key. */
  async createReview(
    client: PoolClient,
    findingId: string,
    source: 'SALES' | 'OPERATIONS',
    status: AnomalyStatus,
    actorId: string,
  ): Promise<string> {
    const column = source === 'SALES' ? 'sales_detection_id' : 'operational_anomaly_id';
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO anomaly_reviews (${column}, status, updated_by) VALUES ($1, $2, $3)
       RETURNING id`,
      [findingId, status, actorId],
    );
    return rows[0].id;
  }

  async updateReview(
    client: PoolClient,
    reviewId: string,
    status: AnomalyStatus,
    actorId: string,
  ): Promise<void> {
    await client.query(
      `UPDATE anomaly_reviews SET status = $2, updated_by = $3, updated_at = now() WHERE id = $1`,
      [reviewId, status, actorId],
    );
  }

  async addEvent(
    client: PoolClient,
    reviewId: string,
    from: AnomalyStatus,
    to: AnomalyStatus,
    note: string | null,
    actorId: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO anomaly_review_events (review_id, from_status, to_status, note, actor_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [reviewId, from, to, note, actorId],
    );
  }

  // ------------------------------------------------------- operational rules (event consumer)

  async ledgerDay(client: PoolClient, ledgerId: string): Promise<string | null> {
    const { rows } = await client.query<{ day: string }>(
      `SELECT (occurred_at AT TIME ZONE 'UTC')::date::text AS day FROM inventory_ledger WHERE id = $1`,
      [ledgerId],
    );
    return rows[0]?.day ?? null;
  }

  /** Stock-reducing adjustments of one product at one location in the `days` days up to `day`. */
  async negativeAdjustments(
    client: PoolClient,
    productId: string,
    locationId: string,
    day: string,
    days: number,
  ): Promise<number> {
    const { rows } = await client.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM inventory_ledger
        WHERE product_id = $1 AND location_id = $2 AND movement_type = 'ADJUSTMENT'
          AND on_hand_delta < 0
          AND (occurred_at AT TIME ZONE 'UTC')::date BETWEEN $3::date - ($4::int - 1) AND $3::date`,
      [productId, locationId, day, days],
    );
    return rows[0].n;
  }

  /** Return movements and sale lines of one product at one location in the window up to `day`. */
  async returnsAndSales(
    client: PoolClient,
    productId: string,
    locationId: string,
    day: string,
    days: number,
  ): Promise<{ returns: number; sales: number }> {
    const { rows } = await client.query<{ returns: number; sales: number }>(
      `SELECT COUNT(*) FILTER (WHERE movement_type = 'RETURN')::int AS returns,
              COUNT(*) FILTER (WHERE movement_type = 'SALE')::int AS sales
         FROM inventory_ledger
        WHERE product_id = $1 AND location_id = $2 AND movement_type IN ('RETURN', 'SALE')
          AND (occurred_at AT TIME ZONE 'UTC')::date BETWEEN $3::date - ($4::int - 1) AND $3::date`,
      [productId, locationId, day, days],
    );
    return rows[0];
  }

  /**
   * Store a finding unless the same kind was already found for this product and location within
   * `withinDays` days (one finding per burst). Returns true if it was new.
   */
  async insertOperational(
    client: PoolClient,
    f: RuleFinding,
    productId: string,
    locationId: string,
    day: string,
    withinDays: number,
    eventId: string | null,
  ): Promise<boolean> {
    const res = await client.query(
      `INSERT INTO operational_anomalies (product_id, location_id, day, kind, severity, score,
          observed, expected, explanation, details, source_event_id)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
        WHERE NOT EXISTS (
          SELECT 1 FROM operational_anomalies
           WHERE product_id = $1 AND location_id = $2 AND kind = $4
             AND day BETWEEN $3::date - ($12::int - 1) AND $3::date)
       ON CONFLICT (product_id, location_id, day, kind) DO NOTHING`,
      [
        productId,
        locationId,
        day,
        f.kind,
        f.severity,
        f.score,
        f.observed,
        f.expected,
        f.explanation,
        JSON.stringify(f.details),
        eventId,
        withinDays,
      ],
    );
    return res.rowCount === 1;
  }
}
