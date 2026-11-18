import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../core/database/database.service';
import { offsetOf } from '../../core/http/query';
import type { ItemResult } from './classifications.calc';
import type {
  ClassificationRun,
  ClassifiedItem,
  ListClassificationsQuery,
} from './classifications.schemas';

export interface WeeklyRow {
  productId: string;
  locationId: string;
  /** 0 = the last week of the window, 1 = the week before, … */
  weeksAgo: number;
  units: number;
}

const RUN = `
  SELECT id, calculated_at AS "calculatedAt", window_start::text AS "windowStart",
         window_end::text AS "windowEnd", data_label AS "dataLabel", item_count AS "itemCount",
         (SELECT display_name FROM users u WHERE u.id = r.triggered_by) AS "triggeredBy"
    FROM classification_runs r`;

/**
 * SQL for ABC/XYZ. Reads the sales history (forecast.demand_daily, written by the forecasting
 * service) and product costs read-only; writes only its own two tables (decision #57).
 */
@Injectable()
export class ClassificationsRepository {
  constructor(private readonly db: DatabaseService) {}

  /** The window: the last `weeks` × 7 days ending on the latest day with sales data. */
  async window(weeks: number): Promise<{ start: string; end: string; label: string } | null> {
    const { rows } = await this.db.query<{ start: string; end: string; label: string | null }>(
      `WITH b AS (SELECT max(day) AS e FROM forecast.demand_daily)
       SELECT (b.e - ($1::int * 7 - 1))::text AS start, b.e::text AS "end",
              (SELECT CASE WHEN count(DISTINCT source) > 1 THEN 'MIXED' ELSE max(source) END
                 FROM forecast.demand_daily d WHERE d.day > b.e - $1::int * 7) AS label
         FROM b WHERE b.e IS NOT NULL`,
      [weeks],
    );
    return rows[0]
      ? { start: rows[0].start, end: rows[0].end, label: rows[0].label ?? 'SYNTHETIC' }
      : null;
  }

  /** Units per active product × store × week inside the window. */
  async weekly(start: string, end: string): Promise<WeeklyRow[]> {
    const { rows } = await this.db.query<WeeklyRow>(
      `SELECT d.product_id AS "productId", d.location_id AS "locationId",
              (($2::date - d.day) / 7)::int AS "weeksAgo", SUM(d.units)::int AS units
         FROM forecast.demand_daily d
         JOIN products p ON p.id = d.product_id AND p.is_active
         JOIN locations l ON l.id = d.location_id AND l.type = 'STORE'
        WHERE d.day BETWEEN $1::date AND $2::date
        GROUP BY 1, 2, 3`,
      [start, end],
    );
    return rows;
  }

  /** First day with data per product × store (how long the item has existed there). */
  async firstDays(): Promise<{ productId: string; locationId: string; first: string }[]> {
    const { rows } = await this.db.query<{ productId: string; locationId: string; first: string }>(
      `SELECT product_id AS "productId", location_id AS "locationId", min(day)::text AS first
         FROM forecast.demand_daily GROUP BY 1, 2`,
    );
    return rows;
  }

  /** Unit cost per active product: primary supplier cost, else the selling price. */
  async unitCosts(): Promise<Map<string, number>> {
    const { rows } = await this.db.query<{ id: string; cost: number }>(
      `SELECT p.id, COALESCE(sp.unit_cost, p.unit_price)::float8 AS cost
         FROM products p
         LEFT JOIN supplier_products sp ON sp.product_id = p.id AND sp.is_primary
        WHERE p.is_active`,
    );
    return new Map(rows.map((r) => [r.id, r.cost]));
  }

  async stores(): Promise<{ id: string; code: string }[]> {
    const { rows } = await this.db.query<{ id: string; code: string }>(
      `SELECT id, code::text AS code FROM locations WHERE type = 'STORE' ORDER BY code`,
    );
    return rows;
  }

  async saveRun(
    client: PoolClient,
    run: { start: string; end: string; label: string; triggeredBy: string | null },
    items: { productId: string; locationId: string | null; r: ItemResult }[],
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO classification_runs (window_start, window_end, data_label, item_count, triggered_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [run.start, run.end, run.label, items.length, run.triggeredBy],
    );
    const runId = rows[0].id;
    const col = <T>(f: (x: (typeof items)[number]) => T) => items.map(f);
    await client.query(
      `INSERT INTO inventory_classifications (run_id, product_id, location_id, weeks_observed, units,
          value, value_share, cumulative_share, weekly_mean, cv, adi, abc, xyz, cls)
       SELECT $1, * FROM unnest($2::uuid[], $3::uuid[], $4::int[], $5::int[], $6::numeric[],
          $7::numeric[], $8::numeric[], $9::numeric[], $10::numeric[], $11::numeric[],
          $12::char(1)[], $13::char(1)[], $14::text[])`,
      [
        runId,
        col((x) => x.productId),
        col((x) => x.locationId),
        col((x) => x.r.weeksObserved),
        col((x) => x.r.units),
        col((x) => x.r.value.toFixed(2)),
        col((x) => Math.min(x.r.valueShare, 1).toFixed(6)),
        col((x) => Math.min(x.r.cumulativeShare, 1).toFixed(6)),
        col((x) => x.r.weeklyMean.toFixed(4)),
        col((x) => (x.r.cv === null ? null : x.r.cv.toFixed(4))),
        col((x) => (x.r.adi === null ? null : x.r.adi.toFixed(4))),
        col((x) => x.r.abc),
        col((x) => x.r.xyz),
        col((x) => x.r.cls),
      ],
    );
    return runId;
  }

  async pruneRuns(client: PoolClient, keep: number): Promise<void> {
    await client.query(
      `DELETE FROM classification_runs WHERE id NOT IN (
         SELECT id FROM classification_runs ORDER BY calculated_at DESC LIMIT $1)`,
      [keep],
    );
  }

  async latestRun(): Promise<ClassificationRun | null> {
    const { rows } = await this.db.query<ClassificationRun>(
      `${RUN} ORDER BY calculated_at DESC LIMIT 1`,
    );
    return rows[0] ?? null;
  }

  async cells(
    runId: string,
    locationId: string | null,
  ): Promise<{ cls: string; count: number; valueShare: number }[]> {
    const { rows } = await this.db.query<{ cls: string; count: number; valueShare: number }>(
      `SELECT cls, COUNT(*)::int AS count, COALESCE(SUM(value_share), 0)::float8 AS "valueShare"
         FROM inventory_classifications
        WHERE run_id = $1 AND location_id IS NOT DISTINCT FROM $2::uuid
        GROUP BY cls ORDER BY cls`,
      [runId, locationId],
    );
    return rows;
  }

  async list(
    runId: string,
    q: ListClassificationsQuery,
  ): Promise<{ rows: ClassifiedItem[]; total: number }> {
    const where = `WHERE c.run_id = $1 AND c.location_id IS NOT DISTINCT FROM $2::uuid
                     AND ($3::text IS NULL OR c.cls = $3)
                     AND ($4::text IS NULL OR p.sku ILIKE '%' || $4 || '%' OR p.name ILIKE '%' || $4 || '%')`;
    const params = [runId, q.locationId ?? null, q.cls ?? null, q.q ?? null];
    const [rows, count] = await Promise.all([
      this.db.query<ClassifiedItem>(
        `SELECT c.product_id AS "productId", p.sku::text AS sku, p.name AS "productName", c.cls,
                c.abc, c.xyz, c.weeks_observed AS "weeksObserved", c.units,
                c.value::float8 AS value, c.value_share::float8 AS "valueShare",
                c.cumulative_share::float8 AS "cumulativeShare",
                c.weekly_mean::float8 AS "weeklyMean", c.cv::float8 AS cv, c.adi::float8 AS adi
           FROM inventory_classifications c JOIN products p ON p.id = c.product_id
           ${where}
          ORDER BY ${q.sort} NULLS LAST, p.sku
          LIMIT $5 OFFSET $6`,
        [...params, q.pageSize, offsetOf(q)],
      ),
      this.db.query<{ total: number }>(
        `SELECT COUNT(*)::int AS total
           FROM inventory_classifications c JOIN products p ON p.id = c.product_id ${where}`,
        params,
      ),
    ]);
    return { rows: rows.rows, total: count.rows[0].total };
  }
}
