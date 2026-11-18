import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';
import { offsetOf } from '../../core/http/query';
import type {
  ListReportsQuery,
  ReportContent,
  ReportDetail,
  ReportKind,
  ReportSummary,
} from './reports.schemas';

/** `col` falls inside the UTC days $1..$2 (inclusive). Sargable: compares timestamps. */
const inPeriod = (col: string) =>
  `${col} >= ($1::date)::timestamp AT TIME ZONE 'UTC' AND ${col} < ($2::date + 1)::timestamp AT TIME ZONE 'UTC'`;
/** $3 = location scope (null = everything). */
const inScope = (col: string) => `($3::uuid[] IS NULL OR ${col} = ANY($3))`;

const SUMMARY = `
  r.id, r.kind, r.period_start::text AS "periodStart", r.period_end::text AS "periodEnd",
  r.location_id AS "locationId", l.code::text AS "locationCode", r.trigger,
  u.display_name AS "generatedBy", r.generated_at AS "generatedAt", r.duration_ms AS "durationMs"`;
const FROM = `
  FROM report_runs r
  LEFT JOIN locations l ON l.id = r.location_id
  LEFT JOIN users u ON u.id = r.generated_by`;

type Args = [string, string, string[] | null];

/**
 * Reports read the ledger and the work tables for a period and scope; they write only
 * `report_runs` (decision: reports are snapshots, never recomputed).
 */
@Injectable()
export class ReportsRepository {
  constructor(private readonly db: DatabaseService) {}

  /** Yesterday as a UTC calendar day, from the database clock. */
  async yesterdayUtc(): Promise<string> {
    const { rows } = await this.db.query<{ d: string }>(
      `SELECT ((now() AT TIME ZONE 'UTC')::date - 1)::text AS d`,
    );
    return rows[0].d;
  }

  async location(
    id: string,
  ): Promise<{ locationId: string; code: string; name: string; type: string } | null> {
    const { rows } = await this.db.query<{
      locationId: string;
      code: string;
      name: string;
      type: string;
    }>(
      `SELECT id AS "locationId", code::text AS code, name, type::text AS type FROM locations WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async sales(a: Args): Promise<Omit<ReportContent['sales'], 'byStore' | 'topProducts'>> {
    const { rows } = await this.db.query<Omit<ReportContent['sales'], 'byStore' | 'topProducts'>>(
      `SELECT COALESCE(SUM(-g.on_hand_delta) FILTER (WHERE g.movement_type = 'SALE'), 0)::int AS "unitsSold",
              COALESCE(SUM(g.on_hand_delta) FILTER (WHERE g.movement_type = 'RETURN'), 0)::int AS "unitsReturned",
              ROUND(COALESCE(SUM(-g.on_hand_delta * p.unit_price) FILTER (WHERE g.movement_type = 'SALE'), 0), 2)::float8
                AS "salesValueAtPrice"
         FROM inventory_ledger g JOIN products p ON p.id = g.product_id
        WHERE ${inPeriod('g.occurred_at')} AND ${inScope('g.location_id')}
          AND g.movement_type IN ('SALE', 'RETURN')`,
      a,
    );
    return rows[0];
  }

  async salesByStore(a: Args): Promise<ReportContent['sales']['byStore']> {
    const { rows } = await this.db.query<ReportContent['sales']['byStore'][number]>(
      `SELECT l.id AS "locationId", l.code::text AS code,
              COALESCE(SUM(-g.on_hand_delta), 0)::int AS "unitsSold",
              ROUND(COALESCE(SUM(-g.on_hand_delta * p.unit_price), 0), 2)::float8 AS "valueAtPrice"
         FROM locations l
         LEFT JOIN inventory_ledger g ON g.location_id = l.id AND g.movement_type = 'SALE'
              AND ${inPeriod('g.occurred_at')}
         LEFT JOIN products p ON p.id = g.product_id
        WHERE l.type = 'STORE' AND ${inScope('l.id')}
        GROUP BY l.id ORDER BY l.code`,
      a,
    );
    return rows;
  }

  async topProducts(a: Args, limit = 10): Promise<ReportContent['sales']['topProducts']> {
    const { rows } = await this.db.query<ReportContent['sales']['topProducts'][number]>(
      `SELECT p.id AS "productId", p.sku::text AS sku, p.name,
              SUM(-g.on_hand_delta)::int AS "unitsSold",
              ROUND(SUM(-g.on_hand_delta * p.unit_price), 2)::float8 AS "valueAtPrice"
         FROM inventory_ledger g JOIN products p ON p.id = g.product_id
        WHERE g.movement_type = 'SALE' AND ${inPeriod('g.occurred_at')} AND ${inScope('g.location_id')}
        GROUP BY p.id ORDER BY "unitsSold" DESC, p.sku LIMIT ${Number(limit)}`,
      a,
    );
    return rows;
  }

  async movements(a: Args): Promise<ReportContent['movements']> {
    const { rows } = await this.db.query<ReportContent['movements']>(
      `SELECT COALESCE(SUM(on_hand_delta) FILTER (WHERE movement_type = 'RECEIPT'), 0)::int AS receipts,
              COALESCE(SUM(on_hand_delta) FILTER (WHERE movement_type = 'TRANSFER_IN'), 0)::int AS "transfersIn",
              COALESCE(SUM(-on_hand_delta) FILTER (WHERE movement_type = 'TRANSFER_OUT'), 0)::int AS "transfersOut",
              COALESCE(SUM(on_hand_delta) FILTER (WHERE movement_type = 'RETURN'), 0)::int AS returns,
              COALESCE(SUM(on_hand_delta) FILTER (WHERE movement_type = 'ADJUSTMENT'), 0)::int AS "adjustmentsNet",
              COALESCE(SUM(-on_hand_delta) FILTER (WHERE movement_type = 'ADJUSTMENT' AND on_hand_delta < 0), 0)::int
                AS "adjustmentsRemoved"
         FROM inventory_ledger
        WHERE ${inPeriod('occurred_at')} AND ${inScope('location_id')}`,
      a,
    );
    return rows[0];
  }

  async work(a: Args): Promise<ReportContent['work']> {
    const touching = `(${inScope('t.source_location_id')} OR ($3::uuid[] IS NOT NULL AND t.destination_location_id = ANY($3)))`;
    const { rows } = await this.db.query<ReportContent['work']>(
      `SELECT
         (SELECT COUNT(*)::int FROM stock_transfers t WHERE ${inPeriod('t.requested_at')} AND ${touching})
           AS "transfersRequested",
         (SELECT COUNT(*)::int FROM stock_transfers t WHERE ${inPeriod('t.dispatched_at')} AND ${touching})
           AS "transfersDispatched",
         (SELECT COUNT(*)::int FROM stock_transfers t WHERE ${inPeriod('t.received_at')} AND ${touching})
           AS "transfersReceived",
         (SELECT COUNT(*)::int FROM purchase_orders po
           WHERE ${inPeriod('po.created_at')} AND ${inScope('po.destination_location_id')}) AS "purchaseOrdersCreated",
         (SELECT COUNT(*)::int FROM purchase_orders po
           WHERE ${inPeriod('po.received_at')} AND ${inScope('po.destination_location_id')}) AS "purchaseOrdersReceived",
         (SELECT COUNT(*)::int FROM replenishment_recommendations r
           WHERE ${inPeriod('r.generated_at')} AND ${inScope('r.location_id')}) AS "recommendationsGenerated",
         (SELECT COUNT(*)::int FROM replenishment_recommendations r
           WHERE r.status = 'APPROVED' AND ${inPeriod('r.decided_at')} AND ${inScope('r.location_id')})
           AS "recommendationsApproved",
         (SELECT COUNT(*)::int FROM replenishment_recommendations r
           WHERE r.status = 'REJECTED' AND ${inPeriod('r.decided_at')} AND ${inScope('r.location_id')})
           AS "recommendationsRejected",
         (SELECT COUNT(*)::int FROM alerts al
           WHERE ${inPeriod('al.created_at')} AND ${inScope('al.location_id')}) AS "alertsOpened",
         (SELECT COUNT(*)::int FROM anomaly_findings f
           WHERE ${inPeriod('f.found_at')} AND ${inScope('f.location_id')}) AS "anomaliesFound",
         (SELECT COUNT(*)::int FROM anomaly_findings f
           WHERE ${inPeriod('f.reviewed_at')} AND ${inScope('f.location_id')}) AS "anomaliesReviewed"`,
      a,
    );
    return rows[0];
  }

  /** Stores a report; a scheduled duplicate (same kind, period, scope) is skipped → null. */
  async save(r: {
    kind: ReportKind;
    periodStart: string;
    periodEnd: string;
    locationId: string | null;
    trigger: 'MANUAL' | 'SCHEDULED';
    generatedBy: string | null;
    durationMs: number;
    content: ReportContent;
  }): Promise<string | null> {
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO report_runs (kind, period_start, period_end, location_id, trigger, generated_by,
          duration_ms, content)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT DO NOTHING RETURNING id`,
      [
        r.kind,
        r.periodStart,
        r.periodEnd,
        r.locationId,
        r.trigger,
        r.generatedBy,
        r.durationMs,
        JSON.stringify(r.content),
      ],
    );
    return rows[0]?.id ?? null;
  }

  async scheduledExists(kind: ReportKind, periodStart: string): Promise<boolean> {
    const { rows } = await this.db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM report_runs
        WHERE trigger = 'SCHEDULED' AND kind = $1 AND period_start = $2 AND location_id IS NULL`,
      [kind, periodStart],
    );
    return rows[0].n > 0;
  }

  async find(id: string): Promise<ReportDetail | null> {
    const { rows } = await this.db.query<ReportDetail>(
      `SELECT ${SUMMARY}, r.content ${FROM} WHERE r.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /** `scope` = locations the caller may see (null = all); network reports need a null scope. */
  async list(
    q: ListReportsQuery,
    scope: string[] | null,
  ): Promise<{ rows: ReportSummary[]; total: number }> {
    const where = `
      WHERE ($1::text IS NULL OR r.kind = $1)
        AND ($2::uuid IS NULL OR r.location_id = $2)
        AND ($3::uuid[] IS NULL OR r.location_id = ANY($3))`;
    const params = [q.kind ?? null, q.locationId ?? null, scope];
    const [rows, count] = await Promise.all([
      this.db.query<ReportSummary>(
        `SELECT ${SUMMARY} ${FROM} ${where}
          ORDER BY r.period_end DESC, r.generated_at DESC, r.id LIMIT $4 OFFSET $5`,
        [...params, q.pageSize, offsetOf(q)],
      ),
      this.db.query<{ total: number }>(
        `SELECT COUNT(*)::int AS total FROM report_runs r ${where}`,
        params,
      ),
    ]);
    return { rows: rows.rows, total: count.rows[0].total };
  }
}
