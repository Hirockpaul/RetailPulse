import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';
import type { PositionRow } from './overview.calc';
import type { AlertCounts, RecommendationCounts } from './overview.schemas';

/**
 * Read-only SQL for the Overview page. This module is a read model: it aggregates across
 * stock, forecast, recommendation and alert tables and never writes anything
 * (docs/ARCHITECTURE.md decision #42). `locationIds` null = every store.
 */
@Injectable()
export class OverviewRepository {
  constructor(private readonly db: DatabaseService) {}

  async storeCount(locationIds: string[] | null): Promise<number> {
    const { rows } = await this.db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM locations
        WHERE type = 'STORE' AND ($1::uuid[] IS NULL OR id = ANY($1))`,
      [locationIds],
    );
    return rows[0].n;
  }

  /**
   * Every active product at every store in scope, with its stock, inbound (approved or
   * dispatched transfers + approved purchase orders) and — if `runId` is given — its forecast.
   */
  async positions(
    runId: string | null,
    riskWindowDays: number,
    locationIds: string[] | null,
  ): Promise<PositionRow[]> {
    const { rows } = await this.db.query<PositionRow>(
      `WITH pts AS (
         SELECT product_id, location_id,
                COALESCE(SUM(yhat) FILTER (WHERE horizon_day <= $2), 0)::float8 AS demand_window,
                AVG(yhat)::float8 AS avg_daily
           FROM forecast.points WHERE run_id = $1 GROUP BY 1, 2),
       inbound AS (
         SELECT product_id, location_id, SUM(quantity)::int AS qty FROM (
           SELECT tl.product_id, t.destination_location_id AS location_id, tl.quantity
             FROM stock_transfer_lines tl JOIN stock_transfers t ON t.id = tl.transfer_id
            WHERE t.status IN ('APPROVED', 'DISPATCHED')
           UNION ALL
           SELECT pl.product_id, po.destination_location_id, pl.quantity
             FROM purchase_order_lines pl JOIN purchase_orders po ON po.id = pl.purchase_order_id
            WHERE po.status = 'APPROVED') x
          GROUP BY 1, 2)
       SELECT b.product_id AS "productId", p.sku::text AS sku, p.name AS "productName",
              b.location_id AS "locationId", l.code::text AS "locationCode",
              (b.on_hand - b.reserved)::int AS available, COALESCE(i.qty, 0)::int AS inbound,
              pts.demand_window AS "demandWindow", pts.avg_daily AS "avgDaily"
         FROM inventory_balances b
         JOIN locations l ON l.id = b.location_id AND l.type = 'STORE'
         JOIN products p ON p.id = b.product_id AND p.is_active
         LEFT JOIN pts ON pts.product_id = b.product_id AND pts.location_id = b.location_id
         LEFT JOIN inbound i ON i.product_id = b.product_id AND i.location_id = b.location_id
        WHERE ($3::uuid[] IS NULL OR b.location_id = ANY($3))`,
      [runId, riskWindowDays, locationIds],
    );
    return rows;
  }

  async recommendationCounts(locationIds: string[] | null): Promise<RecommendationCounts> {
    const { rows } = await this.db.query<RecommendationCounts>(
      `SELECT COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending,
              COUNT(*) FILTER (WHERE status = 'PENDING' AND risk = 'CRITICAL')::int AS critical,
              COUNT(*) FILTER (WHERE status = 'PENDING' AND risk = 'HIGH')::int AS high,
              COUNT(*) FILTER (WHERE status = 'PENDING' AND action = 'TRANSFER')::int AS transfer,
              COUNT(*) FILTER (WHERE status = 'PENDING' AND action = 'PURCHASE_ORDER')::int
                AS "purchaseOrder",
              COUNT(*) FILTER (WHERE status = 'PENDING' AND action = 'REDISTRIBUTE_EXCESS')::int
                AS "redistributeExcess",
              MAX(generated_at) AS "lastGeneratedAt"
         FROM replenishment_recommendations
        WHERE ($1::uuid[] IS NULL OR location_id = ANY($1))`,
      [locationIds],
    );
    return rows[0];
  }

  async alertCounts(locationIds: string[] | null): Promise<AlertCounts> {
    const { rows } = await this.db.query<AlertCounts>(
      `SELECT COUNT(*)::int AS open,
              COUNT(*) FILTER (WHERE kind = 'OUT_OF_STOCK')::int AS "outOfStock",
              COUNT(*) FILTER (WHERE kind = 'LOW_STOCK')::int AS "lowStock"
         FROM alerts
        WHERE status = 'OPEN' AND ($1::uuid[] IS NULL OR location_id = ANY($1))`,
      [locationIds],
    );
    return rows[0];
  }

  async lastMovementAt(locationIds: string[] | null): Promise<Date | null> {
    const { rows } = await this.db.query<{ at: Date | null }>(
      `SELECT MAX(occurred_at) AS at FROM inventory_ledger
        WHERE ($1::uuid[] IS NULL OR location_id = ANY($1))`,
      [locationIds],
    );
    return rows[0].at;
  }
}
