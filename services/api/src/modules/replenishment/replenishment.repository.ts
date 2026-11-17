import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../core/database/database.service';
import { offsetOf } from '../../core/http/query';
import type { DcStock } from './replenishment.calc';
import type {
  ListRecommendationsQuery,
  LockedRecommendation,
  NewRecommendation,
  PairRow,
  RecommendationDetail,
  RecommendationStatus,
  RecommendationSummary,
} from './replenishment.schemas';

const SUMMARY_COLUMNS = `
  r.id, r.status, r.action, r.quantity, r.risk, r.days_of_cover::float8 AS "daysOfCover",
  r.generated_at AS "generatedAt", r.forecast_run_id AS "forecastRunId",
  r.product_id AS "productId", p.sku::text AS sku, p.name AS "productName", p.pack_size AS "packSize",
  r.location_id AS "locationId", l.code::text AS "locationCode",
  r.source_location_id AS "sourceLocationId", sl.code::text AS "sourceCode",
  r.supplier_id AS "supplierId", s.name AS "supplierName",
  du.display_name AS "decidedBy", r.decided_at AS "decidedAt", r.decision_note AS "decisionNote",
  r.transfer_id AS "transferId", r.purchase_order_id AS "purchaseOrderId"`;

const FROM = `
  FROM replenishment_recommendations r
  JOIN products p ON p.id = r.product_id
  JOIN locations l ON l.id = r.location_id
  LEFT JOIN locations sl ON sl.id = r.source_location_id
  LEFT JOIN suppliers s ON s.id = r.supplier_id
  LEFT JOIN users du ON du.id = r.decided_by`;

const FILTER = `
  WHERE ($1::recommendation_status IS NULL OR r.status = $1)
    AND ($2::recommendation_action IS NULL OR r.action = $2)
    AND ($3::stockout_risk IS NULL OR r.risk = $3)
    AND ($4::uuid IS NULL OR r.location_id = $4)
    AND ($5::uuid IS NULL OR r.product_id = $5)
    AND ($6::uuid[] IS NULL OR r.location_id = ANY($6))`;

@Injectable()
export class ReplenishmentRepository {
  constructor(private readonly db: DatabaseService) {}

  /** Every product x store of a forecast run with its forecast, stock and supplier terms. */
  async loadPairs(runId: string): Promise<PairRow[]> {
    const { rows } = await this.db.query<PairRow>(
      `WITH pts AS (
         SELECT product_id, location_id, array_agg(yhat::float8 ORDER BY horizon_day) AS yhat
           FROM forecast.points WHERE run_id = $1 GROUP BY 1, 2)
       SELECT s.product_id AS "productId", s.location_id AS "locationId", l.code::text AS "locationCode",
              p.sku::text AS sku, p.name AS "productName", p.pack_size AS "packSize",
              s.model, s.is_fallback AS "isFallback", s.history_days AS "historyDays",
              s.test_wape::float8 AS "testWape", s.std_daily_90::float8 AS "sigmaDaily", pts.yhat,
              COALESCE(b.on_hand, 0) AS "onHand", COALESCE(b.reserved, 0) AS reserved,
              (COALESCE((SELECT SUM(tl.quantity) FROM stock_transfer_lines tl
                           JOIN stock_transfers t ON t.id = tl.transfer_id
                          WHERE tl.product_id = s.product_id AND t.destination_location_id = s.location_id
                            AND t.status IN ('APPROVED', 'DISPATCHED')), 0)
               + COALESCE((SELECT SUM(pl.quantity) FROM purchase_order_lines pl
                             JOIN purchase_orders po ON po.id = pl.purchase_order_id
                            WHERE pl.product_id = s.product_id AND po.destination_location_id = s.location_id
                              AND po.status = 'APPROVED'), 0))::int AS inbound,
              sp.supplier_id AS "supplierId", sup.name AS "supplierName",
              sp.lead_time_days AS "leadTimeDays", sp.min_order_qty AS "minOrderQty",
              sp.unit_cost::float8 AS "unitCost"
         FROM forecast.series s
         JOIN pts ON pts.product_id = s.product_id AND pts.location_id = s.location_id
         JOIN products p ON p.id = s.product_id AND p.is_active
         JOIN locations l ON l.id = s.location_id AND l.type = 'STORE'
         LEFT JOIN inventory_balances b ON b.product_id = s.product_id AND b.location_id = s.location_id
         LEFT JOIN supplier_products sp ON sp.product_id = s.product_id AND sp.is_primary
         LEFT JOIN suppliers sup ON sup.id = sp.supplier_id
        WHERE s.run_id = $1`,
      [runId],
    );
    return rows;
  }

  /** Distribution-centre stock not already promised to open (requested / approved) transfers. */
  async loadDcStock(): Promise<Map<string, DcStock[]>> {
    const { rows } = await this.db.query<DcStock & { productId: string }>(
      `SELECT b.product_id AS "productId", l.id AS "locationId", l.code::text AS code,
              (b.on_hand - b.reserved - COALESCE(o.qty, 0))::int AS "availableNet"
         FROM inventory_balances b
         JOIN locations l ON l.id = b.location_id AND l.type = 'DISTRIBUTION_CENTER'
         LEFT JOIN LATERAL (
           SELECT SUM(tl.quantity)::int AS qty
             FROM stock_transfer_lines tl JOIN stock_transfers t ON t.id = tl.transfer_id
            WHERE tl.product_id = b.product_id AND t.source_location_id = b.location_id
              AND t.status IN ('REQUESTED', 'APPROVED')) o ON true
        WHERE b.on_hand - b.reserved - COALESCE(o.qty, 0) > 0`,
    );
    const byProduct = new Map<string, DcStock[]>();
    for (const { productId, ...dc } of rows) {
      byProduct.set(productId, [...(byProduct.get(productId) ?? []), dc]);
    }
    return byProduct;
  }

  /** Serialize concurrent "generate" calls (the one-pending-per-pair index would otherwise clash). */
  async lockGeneration(client: PoolClient): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(727002)');
  }

  async expirePending(client: PoolClient): Promise<number> {
    const res = await client.query(
      `UPDATE replenishment_recommendations SET status = 'EXPIRED' WHERE status = 'PENDING'`,
    );
    return res.rowCount ?? 0;
  }

  async insert(client: PoolClient, r: NewRecommendation): Promise<void> {
    await client.query(
      `INSERT INTO replenishment_recommendations
         (forecast_run_id, product_id, location_id, action, source_location_id, supplier_id,
          quantity, risk, days_of_cover, inputs, explanation)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        r.forecastRunId,
        r.productId,
        r.locationId,
        r.action,
        r.sourceLocationId,
        r.supplierId,
        r.quantity,
        r.risk,
        r.daysOfCover === null ? null : Math.round(r.daysOfCover * 100) / 100,
        JSON.stringify(r.inputs),
        r.explanation,
      ],
    );
  }

  async lock(client: PoolClient, id: string): Promise<LockedRecommendation | null> {
    const { rows } = await client.query<LockedRecommendation>(
      `SELECT status, action, product_id AS "productId", location_id AS "locationId",
              source_location_id AS "sourceLocationId", supplier_id AS "supplierId",
              quantity, inputs
         FROM replenishment_recommendations WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return rows[0] ?? null;
  }

  async decide(
    client: PoolClient,
    id: string,
    status: Extract<RecommendationStatus, 'APPROVED' | 'REJECTED'>,
    userId: string,
    note: string | undefined,
    links: { transferId?: string; purchaseOrderId?: string },
  ): Promise<void> {
    await client.query(
      `UPDATE replenishment_recommendations
          SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4,
              transfer_id = $5, purchase_order_id = $6
        WHERE id = $1`,
      [id, status, userId, note ?? null, links.transferId ?? null, links.purchaseOrderId ?? null],
    );
  }

  async find(id: string, client?: PoolClient): Promise<RecommendationDetail | null> {
    const sql = `SELECT ${SUMMARY_COLUMNS}, r.explanation, r.inputs ${FROM} WHERE r.id = $1`;
    const res = client
      ? await client.query<RecommendationDetail>(sql, [id])
      : await this.db.query<RecommendationDetail>(sql, [id]);
    return res.rows[0] ?? null;
  }

  async list(
    q: ListRecommendationsQuery,
    scope: string[] | null,
  ): Promise<{ rows: RecommendationSummary[]; total: number }> {
    const filter = [
      q.status ?? null,
      q.action ?? null,
      q.risk ?? null,
      q.locationId ?? null,
      q.productId ?? null,
      scope,
    ];
    const [rows, count] = await Promise.all([
      this.db.query<RecommendationSummary>(
        `SELECT ${SUMMARY_COLUMNS} ${FROM} ${FILTER}
          ORDER BY (r.risk = 'CRITICAL') DESC, r.days_of_cover NULLS LAST, r.generated_at DESC, r.id
          LIMIT $7 OFFSET $8`,
        [...filter, q.pageSize, offsetOf(q)],
      ),
      this.db.query<{ total: number }>(
        `SELECT COUNT(*)::int AS total FROM replenishment_recommendations r ${FILTER}`,
        filter,
      ),
    ]);
    return { rows: rows.rows, total: count.rows[0].total };
  }
}
