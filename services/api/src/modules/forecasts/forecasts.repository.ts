import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';
import type { StoredContribution } from './forecasts.explain';
import type { ForecastRun, ModelMetric, RangeGroup, SeriesForecast } from './forecasts.schemas';

const RUN_SELECT = `
  SELECT r.id, r.status, r.started_at AS "startedAt", r.finished_at AS "finishedAt",
         r.horizon_days AS "horizonDays", r.data_label AS "dataLabel",
         r.history_start::text AS "historyStart", r.history_end::text AS "historyEnd",
         r.validation_start::text AS "validationStart", r.validation_end::text AS "validationEnd",
         r.test_start::text AS "testStart", r.test_end::text AS "testEnd",
         r.series_count AS "seriesCount", r.fallback_count AS "fallbackCount",
         m.name AS "servedModel", m.kind AS "servedModelKind",
         r.selection_reason AS "selectionReason", r.ml_beat_baseline AS "mlBeatBaseline", r.error,
         r.explanation_status AS "explanationStatus"
    FROM forecast.runs r
    LEFT JOIN forecast.model_versions m ON m.id = r.served_model_version_id`;

/** Read-only SQL over the `forecast` schema (written by the Python service). */
@Injectable()
export class ForecastsRepository {
  constructor(private readonly db: DatabaseService) {}

  async latestRun(succeededOnly = false): Promise<ForecastRun | null> {
    const { rows } = await this.db.query<ForecastRun>(
      `${RUN_SELECT} ${succeededOnly ? "WHERE r.status = 'SUCCEEDED'" : ''}
        ORDER BY r.started_at DESC LIMIT 1`,
    );
    return rows[0] ?? null;
  }

  async metrics(runId: string): Promise<ModelMetric[]> {
    const { rows } = await this.db.query<ModelMetric>(
      `SELECT model, split, mae::text, rmse::text, wape::text, bias::text,
              interval_coverage::text AS "intervalCoverage", interval_width::text AS "intervalWidth",
              interval95_coverage::text AS "interval95Coverage",
              interval95_width::text AS "interval95Width",
              n_points AS "nPoints", n_series AS "nSeries"
         FROM forecast.model_metrics WHERE run_id = $1
        ORDER BY split DESC, wape NULLS LAST`,
      [runId],
    );
    return rows;
  }

  async ranges(runId: string): Promise<RangeGroup[]> {
    const { rows } = await this.db.query<RangeGroup>(
      `SELECT level, forecast_from::float8 AS "forecastFrom", forecast_to::float8 AS "forecastTo",
              q_low::float8 AS "qLow", q_high::float8 AS "qHigh",
              test_coverage::float8 AS "testCoverage", test_points AS "testPoints"
         FROM forecast.interval_calibration WHERE run_id = $1
        ORDER BY level, group_index`,
      [runId],
    );
    return rows;
  }

  /** The stored explanation of the first forecast day for one series, with what is needed to describe it. */
  async explanation(
    runId: string,
    productId: string,
    locationId: string,
  ): Promise<{
    isFallback: boolean | null;
    categoryName: string;
    locationCode: string;
    row: {
      horizonDay: number;
      targetDay: string;
      baseLog: number;
      forecast: number;
      contributions: StoredContribution[];
    } | null;
  } | null> {
    const { rows } = await this.db.query<{
      isFallback: boolean | null;
      categoryName: string;
      locationCode: string;
      horizonDay: number | null;
      targetDay: string | null;
      baseLog: number | null;
      forecast: number | null;
      contributions: StoredContribution[] | null;
    }>(
      `SELECT s.is_fallback AS "isFallback", c.name AS "categoryName", l.code::text AS "locationCode",
              e.horizon_day AS "horizonDay",
              (r.history_end + e.horizon_day)::text AS "targetDay",
              e.base_log::float8 AS "baseLog", e.forecast::float8 AS forecast, e.contributions
         FROM products p
         JOIN categories c ON c.id = p.category_id
         JOIN locations l ON l.id = $3
         JOIN forecast.runs r ON r.id = $1
         LEFT JOIN forecast.series s
                ON s.run_id = $1 AND s.product_id = p.id AND s.location_id = l.id
         LEFT JOIN forecast.explanations e
                ON e.run_id = $1 AND e.product_id = p.id AND e.location_id = l.id AND e.horizon_day = 1
        WHERE p.id = $2`,
      [runId, productId, locationId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      isFallback: r.isFallback,
      categoryName: r.categoryName,
      locationCode: r.locationCode,
      row:
        r.contributions &&
        r.horizonDay !== null &&
        r.targetDay &&
        r.baseLog !== null &&
        r.forecast !== null
          ? {
              horizonDay: r.horizonDay,
              targetDay: r.targetDay,
              baseLog: r.baseLog,
              forecast: r.forecast,
              contributions: r.contributions,
            }
          : null,
    };
  }

  async featureImportance(
    runId: string,
  ): Promise<{ feature: string; meanAbsContribution: number; rank: number }[]> {
    const { rows } = await this.db.query<{
      feature: string;
      meanAbsContribution: number;
      rank: number;
    }>(
      `SELECT feature, mean_abs_contribution::float8 AS "meanAbsContribution", rank
         FROM forecast.feature_importance WHERE run_id = $1 ORDER BY rank`,
      [runId],
    );
    return rows;
  }

  async series(
    runId: string,
    productId: string,
    locationId: string,
    historyDays: number,
  ): Promise<Omit<SeriesForecast, 'run' | 'ranges'> | null> {
    const head = await this.db.query<{
      model: string;
      isFallback: boolean;
      historyDays: number;
      avgDaily28: number;
      stdDaily90: number;
      sigma: number;
      testWape: number | null;
    }>(
      `SELECT model, is_fallback AS "isFallback", history_days AS "historyDays",
              avg_daily_28::float8 AS "avgDaily28", std_daily_90::float8 AS "stdDaily90",
              sigma::float8 AS sigma, test_wape::float8 AS "testWape"
         FROM forecast.series WHERE run_id = $1 AND product_id = $2 AND location_id = $3`,
      [runId, productId, locationId],
    );
    if (head.rows.length === 0) return null;

    const [points, history] = await Promise.all([
      this.db.query<SeriesForecast['points'][number]>(
        `SELECT target_day::text AS day, horizon_day AS "horizonDay", yhat::float8 AS yhat,
                lower::float8 AS lower, upper::float8 AS upper,
                lower95::float8 AS lower95, upper95::float8 AS upper95
           FROM forecast.points WHERE run_id = $1 AND product_id = $2 AND location_id = $3
          ORDER BY target_day`,
        [runId, productId, locationId],
      ),
      this.db.query<SeriesForecast['history'][number]>(
        `SELECT day::text AS day, units FROM (
           SELECT day, units FROM forecast.demand_daily
            WHERE product_id = $1 AND location_id = $2 ORDER BY day DESC LIMIT $3) recent
          ORDER BY day`,
        [productId, locationId, historyDays],
      ),
    ]);
    return { ...head.rows[0], points: points.rows, history: history.rows };
  }
}
