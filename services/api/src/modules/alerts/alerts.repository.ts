import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../core/database/database.service';
import { offsetOf } from '../../core/http/query';
import { type Alert, type ListAlertsQuery, SEVERITY, type SyncAlertInput } from './alerts.schemas';

const SELECT = `
  SELECT a.id, a.kind, a.severity, a.status, a.message,
         a.product_id AS "productId", p.sku::text AS sku, p.name AS "productName",
         a.location_id AS "locationId", l.code::text AS "locationCode",
         a.details, a.created_at AS "createdAt", a.resolved_at AS "resolvedAt"
    FROM alerts a
    JOIN products p ON p.id = a.product_id
    JOIN locations l ON l.id = a.location_id`;

const FILTER = `
  WHERE ($1::alert_status IS NULL OR a.status = $1)
    AND ($2::alert_kind IS NULL OR a.kind = $2)
    AND ($3::uuid IS NULL OR a.location_id = $3)
    AND ($4::uuid IS NULL OR a.product_id = $4)
    AND ($5::uuid[] IS NULL OR a.location_id = ANY($5))`;

@Injectable()
export class AlertsRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Make the alerts for one (product, location) match its current state, inside the caller's
   * transaction. Idempotent: running it twice for the same state changes nothing.
   *  - OK:           resolve any open alert
   *  - LOW / OUT:    keep one open alert of that kind, resolve the other kind
   */
  async sync(client: PoolClient, s: SyncAlertInput): Promise<void> {
    await client.query(
      `UPDATE alerts SET status = 'RESOLVED', resolved_at = now()
        WHERE product_id = $1 AND location_id = $2 AND status = 'OPEN' AND kind::text <> $3`,
      [s.productId, s.locationId, s.state === 'OK' ? '' : s.state],
    );
    if (s.state === 'OK') return;

    await client.query(
      `INSERT INTO alerts (kind, severity, product_id, location_id, message, details, source_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (product_id, location_id, kind) WHERE status = 'OPEN'
       DO UPDATE SET message = EXCLUDED.message, details = EXCLUDED.details,
                     source_event_id = EXCLUDED.source_event_id`,
      [
        s.state,
        SEVERITY[s.state],
        s.productId,
        s.locationId,
        s.message,
        JSON.stringify(s.details),
        s.eventId,
      ],
    );
  }

  async list(
    q: ListAlertsQuery,
    scope: string[] | null,
  ): Promise<{ rows: Alert[]; total: number }> {
    const filter = [
      q.status ?? null,
      q.kind ?? null,
      q.locationId ?? null,
      q.productId ?? null,
      scope,
    ];
    const [rows, count] = await Promise.all([
      this.db.query<Alert>(
        `${SELECT} ${FILTER}
          ORDER BY (a.severity = 'HIGH') DESC, a.created_at DESC, a.id
          LIMIT $6 OFFSET $7`,
        [...filter, q.pageSize, offsetOf(q)],
      ),
      this.db.query<{ total: number }>(
        `SELECT COUNT(*)::int AS total FROM alerts a ${FILTER}`,
        filter,
      ),
    ]);
    return { rows: rows.rows, total: count.rows[0].total };
  }

  /** Pairs worth re-checking: currently below one pack, or with an open alert that may be stale. */
  async rescanCandidates(): Promise<{ productId: string; locationId: string }[]> {
    const { rows } = await this.db.query<{ productId: string; locationId: string }>(
      `SELECT b.product_id AS "productId", b.location_id AS "locationId"
         FROM inventory_balances b JOIN products p ON p.id = b.product_id
        WHERE b.on_hand - b.reserved < p.pack_size
       UNION
       SELECT product_id, location_id FROM alerts WHERE status = 'OPEN'`,
    );
    return rows;
  }
}
