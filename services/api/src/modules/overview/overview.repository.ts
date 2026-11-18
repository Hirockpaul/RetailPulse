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
    riskWindowLongDays: number = riskWindowDays,
  ): Promise<PositionRow[]> {
    const { rows } = await this.db.query<PositionRow>(
      `WITH pts AS (
         SELECT product_id, location_id,
                COALESCE(SUM(yhat) FILTER (WHERE horizon_day <= $2), 0)::float8 AS demand_window,
                COALESCE(SUM(yhat) FILTER (WHERE horizon_day <= $4), 0)::float8 AS demand_long,
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
              pts.demand_window AS "demandWindow", pts.avg_daily AS "avgDaily",
              pts.demand_long AS "demandWindowLong", sp.unit_cost::float8 AS "unitCost"
         FROM inventory_balances b
         JOIN locations l ON l.id = b.location_id AND l.type = 'STORE'
         JOIN products p ON p.id = b.product_id AND p.is_active
         LEFT JOIN pts ON pts.product_id = b.product_id AND pts.location_id = b.location_id
         LEFT JOIN inbound i ON i.product_id = b.product_id AND i.location_id = b.location_id
         LEFT JOIN supplier_products sp ON sp.product_id = b.product_id AND sp.is_primary
        WHERE ($3::uuid[] IS NULL OR b.location_id = ANY($3))`,
      [runId, riskWindowDays, locationIds, riskWindowLongDays],
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

  // ---------------------------------------------------------------- Control Tower (V2 4a-1)

  /**
   * One row per location in scope (null scope = every store and DC): stock, value at cost and
   * the open work attached to it. Value = on hand × primary supplier unit cost.
   */
  async locations(locationIds: string[] | null): Promise<LocationRow[]> {
    const { rows } = await this.db.query<LocationRow>(
      `WITH stock AS (
         SELECT b.location_id, SUM(b.on_hand)::int AS on_hand,
                SUM(b.on_hand - b.reserved)::int AS available,
                SUM(b.on_hand * COALESCE(sp.unit_cost, 0))::float8 AS value
           FROM inventory_balances b
           JOIN products p ON p.id = b.product_id AND p.is_active
           LEFT JOIN supplier_products sp ON sp.product_id = b.product_id AND sp.is_primary
          GROUP BY 1),
       recs AS (SELECT location_id, COUNT(*)::int AS n FROM replenishment_recommendations
                 WHERE status = 'PENDING' GROUP BY 1),
       alerts AS (SELECT location_id, COUNT(*)::int AS n FROM alerts
                   WHERE status = 'OPEN' GROUP BY 1),
       anomalies AS (SELECT location_id, COUNT(*)::int AS n FROM anomaly_findings
                      WHERE status IN ('NEW', 'INVESTIGATING') GROUP BY 1),
       t_in AS (SELECT destination_location_id AS location_id, COUNT(*)::int AS n
                  FROM stock_transfers WHERE status IN ('REQUESTED', 'APPROVED', 'DISPATCHED')
                 GROUP BY 1),
       t_out AS (SELECT source_location_id AS location_id, COUNT(*)::int AS n
                   FROM stock_transfers WHERE status IN ('REQUESTED', 'APPROVED', 'DISPATCHED')
                  GROUP BY 1)
       SELECT l.id AS "locationId", l.code::text AS "locationCode", l.name AS "locationName",
              l.type::text AS "locationType",
              COALESCE(s.on_hand, 0) AS "onHand", COALESCE(s.available, 0) AS available,
              ROUND(COALESCE(s.value, 0)::numeric, 2)::float8 AS "valueAtCost",
              COALESCE(r.n, 0) AS "pendingRecommendations", COALESCE(a.n, 0) AS "openAlerts",
              COALESCE(an.n, 0) AS "openAnomalies", COALESCE(ti.n, 0) AS "transfersIn",
              COALESCE(tt.n, 0) AS "transfersOut"
         FROM locations l
         LEFT JOIN stock s ON s.location_id = l.id
         LEFT JOIN recs r ON r.location_id = l.id
         LEFT JOIN alerts a ON a.location_id = l.id
         LEFT JOIN anomalies an ON an.location_id = l.id
         LEFT JOIN t_in ti ON ti.location_id = l.id
         LEFT JOIN t_out tt ON tt.location_id = l.id
        WHERE ($1::uuid[] IS NULL OR l.id = ANY($1))
        ORDER BY (l.type = 'STORE') DESC, l.code`,
      [locationIds],
    );
    return rows;
  }

  /** Transfers, purchase orders and anomalies needing attention, in scope. */
  async risks(locationIds: string[] | null, transferDelayDays: number): Promise<RiskCounts> {
    const { rows } = await this.db.query<RiskCounts>(
      `SELECT
         (SELECT COUNT(*)::int FROM stock_transfers t
           WHERE t.status IN ('REQUESTED', 'APPROVED', 'DISPATCHED')
             AND ($1::uuid[] IS NULL OR t.source_location_id = ANY($1)
                  OR t.destination_location_id = ANY($1))) AS "openTransfers",
         (SELECT COUNT(*)::int FROM stock_transfers t
           WHERE ((t.status = 'APPROVED' AND t.approved_at < now() - make_interval(days => $2))
               OR (t.status = 'DISPATCHED' AND t.dispatched_at < now() - make_interval(days => $2)))
             AND ($1::uuid[] IS NULL OR t.source_location_id = ANY($1)
                  OR t.destination_location_id = ANY($1))) AS "delayedTransfers",
         (SELECT COUNT(*)::int FROM purchase_orders po
           WHERE po.status = 'APPROVED' AND po.expected_date < current_date
             AND ($1::uuid[] IS NULL OR po.destination_location_id = ANY($1))) AS "overduePurchaseOrders",
         (SELECT COUNT(*)::int FROM anomaly_findings f
           WHERE f.status IN ('NEW', 'INVESTIGATING')
             AND ($1::uuid[] IS NULL OR f.location_id = ANY($1))) AS "openAnomalies",
         (SELECT COUNT(*)::int FROM anomaly_findings f
           WHERE f.status IN ('NEW', 'INVESTIGATING') AND f.severity = 'HIGH'
             AND ($1::uuid[] IS NULL OR f.location_id = ANY($1))) AS "openHighAnomalies"`,
      [locationIds, transferDelayDays],
    );
    return rows[0];
  }

  /** Open (approved, unreceived) purchase orders per supplier, in scope. */
  async openOrdersBySupplier(locationIds: string[] | null): Promise<Map<string, number>> {
    const { rows } = await this.db.query<{ supplierId: string; n: number }>(
      `SELECT supplier_id AS "supplierId", COUNT(*)::int AS n FROM purchase_orders
        WHERE status = 'APPROVED' AND ($1::uuid[] IS NULL OR destination_location_id = ANY($1))
        GROUP BY 1`,
      [locationIds],
    );
    return new Map(rows.map((r) => [r.supplierId, r.n]));
  }

  /**
   * Network (scope) units sold per day for the last `days` days of forecast history, and the
   * latest forecast's units per day. Stores only.
   */
  async salesSeries(
    runId: string | null,
    historyEnd: string | null,
    days: number,
    locationIds: string[] | null,
  ): Promise<{ history: DayUnits[]; forecast: DayUnits[] }> {
    if (!runId || !historyEnd) return { history: [], forecast: [] };
    const [history, forecast] = await Promise.all([
      this.db.query<DayUnits>(
        `SELECT g.day::date::text AS day, COALESCE(SUM(dd.units), 0)::int AS units
           FROM generate_series($1::date - ($2::int - 1), $1::date, interval '1 day') AS g(day)
           LEFT JOIN forecast.demand_daily dd ON dd.day = g.day::date
                 AND ($3::uuid[] IS NULL OR dd.location_id = ANY($3))
          GROUP BY g.day ORDER BY g.day`,
        [historyEnd, days, locationIds],
      ),
      this.db.query<DayUnits>(
        `SELECT target_day::text AS day, ROUND(SUM(yhat)::numeric, 1)::float8 AS units
           FROM forecast.points
          WHERE run_id = $1 AND ($2::uuid[] IS NULL OR location_id = ANY($2))
          GROUP BY target_day ORDER BY target_day`,
        [runId, locationIds],
      ),
    ]);
    return { history: history.rows, forecast: forecast.rows };
  }
}

export interface LocationRow {
  locationId: string;
  locationCode: string;
  locationName: string;
  locationType: 'STORE' | 'DISTRIBUTION_CENTER';
  onHand: number;
  available: number;
  valueAtCost: number;
  pendingRecommendations: number;
  openAlerts: number;
  openAnomalies: number;
  transfersIn: number;
  transfersOut: number;
}

export interface RiskCounts {
  openTransfers: number;
  delayedTransfers: number;
  overduePurchaseOrders: number;
  openAnomalies: number;
  openHighAnomalies: number;
}

export interface DayUnits {
  day: string;
  units: number;
}
