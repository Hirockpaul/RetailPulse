import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';
import type { HealthInput } from './monitoring.health';

export interface MonitoringRunRow {
  id: string;
  createdAt: Date;
  trigger: 'FORECAST_RUN' | 'MANUAL';
  forecastRunId: string | null;
  modelName: string | null;
  trainingEnd: string | null;
  latestDataDay: string | null;
  referenceStart: string | null;
  referenceEnd: string | null;
  currentStart: string | null;
  currentEnd: string | null;
  currentDays: number;
  status: 'SUCCEEDED' | 'FAILED';
  error: string | null;
  dataDrift: string | null;
  predictionDrift: string | null;
  performance: string | null;
}

export interface MonitoringResultRow {
  checkKind: 'FEATURE' | 'STORE_SALES' | 'PREDICTION' | 'PERFORMANCE';
  subject: string;
  locationId: string | null;
  nReference: number | null;
  nCurrent: number | null;
  psi: number | null;
  ksD: number | null;
  ksP: number | null;
  wape: number | null;
  bias: number | null;
  backtestWape: number | null;
  nPoints: number | null;
  nDays: number | null;
  status: string;
}

const RUN = `
  SELECT id, created_at AS "createdAt", trigger, forecast_run_id AS "forecastRunId",
         model_name AS "modelName", training_end::text AS "trainingEnd",
         latest_data_day::text AS "latestDataDay", reference_start::text AS "referenceStart",
         reference_end::text AS "referenceEnd", current_start::text AS "currentStart",
         current_end::text AS "currentEnd", current_days AS "currentDays", status, error,
         data_drift_status AS "dataDrift", prediction_drift_status AS "predictionDrift",
         performance_status AS "performance"
    FROM forecast.monitoring_runs`;

/** Reads monitoring results (written by the forecasting service) and run state. Writes nothing. */
@Injectable()
export class MonitoringRepository {
  constructor(private readonly db: DatabaseService) {}

  async recent(limit = 10): Promise<MonitoringRunRow[]> {
    const { rows } = await this.db.query<MonitoringRunRow>(
      `${RUN} ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return rows;
  }

  async latestSucceeded(): Promise<MonitoringRunRow | null> {
    const { rows } = await this.db.query<MonitoringRunRow>(
      `${RUN} WHERE status = 'SUCCEEDED' ORDER BY created_at DESC LIMIT 1`,
    );
    return rows[0] ?? null;
  }

  async results(runId: string): Promise<MonitoringResultRow[]> {
    const { rows } = await this.db.query<MonitoringResultRow>(
      `SELECT check_kind AS "checkKind", subject, location_id AS "locationId",
              n_reference AS "nReference", n_current AS "nCurrent", psi::float8 AS psi,
              ks_d::float8 AS "ksD", ks_p::float8 AS "ksP", wape::float8 AS wape,
              bias::float8 AS bias, backtest_wape::float8 AS "backtestWape",
              n_points AS "nPoints", n_days AS "nDays", status
         FROM forecast.monitoring_results WHERE run_id = $1
        ORDER BY check_kind, subject`,
      [runId],
    );
    return rows;
  }

  /** Inputs for the run-health checks, dates computed by the database (one clock). */
  async healthInputs(): Promise<
    Pick<
      HealthInput,
      'daysBehind' | 'latestSucceededRunId' | 'latestRun' | 'monitoringCoversLatestRun'
    >
  > {
    const { rows } = await this.db.query<{
      daysBehind: number | null;
      latestSucceededRunId: string | null;
      latestStatus: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | null;
      latestError: string | null;
      covered: boolean;
    }>(
      `WITH ok AS (
         SELECT id, history_end, finished_at FROM forecast.runs
          WHERE status = 'SUCCEEDED' ORDER BY finished_at DESC NULLS LAST LIMIT 1),
       last AS (SELECT status, error FROM forecast.runs ORDER BY started_at DESC LIMIT 1)
       SELECT ((current_date - 1) - (SELECT history_end FROM ok))::int AS "daysBehind",
              (SELECT id FROM ok) AS "latestSucceededRunId",
              (SELECT status FROM last) AS "latestStatus",
              (SELECT error FROM last) AS "latestError",
              EXISTS (
                SELECT 1 FROM forecast.monitoring_runs m, ok
                 WHERE m.forecast_run_id = ok.id OR m.created_at >= ok.finished_at
              ) AS covered`,
    );
    const r = rows[0];
    return {
      daysBehind: r.daysBehind,
      latestSucceededRunId: r.latestSucceededRunId,
      latestRun: r.latestStatus ? { status: r.latestStatus, error: r.latestError } : null,
      monitoringCoversLatestRun: r.covered,
    };
  }
}
