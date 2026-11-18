import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';
import type { BatchSummary } from '../replenishment/replenishment.scenario';
import type { CreateScenario, Scenario, ScenarioResult } from './scenarios.schemas';

const SCENARIO = `
  s.id, s.name, s.description, s.demand_pct AS "demandPct",
  s.supplier_lead_time_days AS "supplierLeadTimeDays", s.dc_availability_pct AS "dcAvailabilityPct",
  u.display_name AS "createdBy", s.created_at AS "createdAt"`;

const RESULT = `
  r.id, r.scenario_id AS "scenarioId", r.forecast_run_id AS "forecastRunId",
  r.forecast_history_end::text AS "forecastHistoryEnd", ru.display_name AS "runBy",
  r.run_at AS "runAt", r.duration_ms AS "durationMs", r.baseline, r.result`;

/** Scenarios and their results — the only tables this module writes. */
@Injectable()
export class ScenariosRepository {
  constructor(private readonly db: DatabaseService) {}

  async create(body: CreateScenario, userId: string): Promise<string> {
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO scenarios (name, description, demand_pct, supplier_lead_time_days,
          dc_availability_pct, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        body.name,
        body.description ?? null,
        body.demandPct,
        body.supplierLeadTimeDays,
        body.dcAvailabilityPct,
        userId,
      ],
    );
    return rows[0].id;
  }

  async find(id: string): Promise<Scenario | null> {
    const { rows } = await this.db.query<Scenario>(
      `SELECT ${SCENARIO} FROM scenarios s JOIN users u ON u.id = s.created_by WHERE s.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async list(): Promise<Scenario[]> {
    const { rows } = await this.db.query<Scenario>(
      `SELECT ${SCENARIO} FROM scenarios s JOIN users u ON u.id = s.created_by
        ORDER BY s.created_at DESC, s.id`,
    );
    return rows;
  }

  /** All results of the given scenarios, newest first. */
  async results(scenarioIds: string[]): Promise<ScenarioResult[]> {
    if (scenarioIds.length === 0) return [];
    const { rows } = await this.db.query<ScenarioResult>(
      `SELECT ${RESULT} FROM scenario_results r JOIN users ru ON ru.id = r.run_by
        WHERE r.scenario_id = ANY($1) ORDER BY r.run_at DESC, r.id`,
      [scenarioIds],
    );
    return rows;
  }

  async saveResult(r: {
    scenarioId: string;
    forecastRunId: string;
    forecastHistoryEnd: string | null;
    runBy: string;
    durationMs: number;
    baseline: BatchSummary;
    result: BatchSummary;
  }): Promise<string> {
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO scenario_results (scenario_id, forecast_run_id, forecast_history_end, run_by,
          duration_ms, baseline, result)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        r.scenarioId,
        r.forecastRunId,
        r.forecastHistoryEnd,
        r.runBy,
        r.durationMs,
        JSON.stringify(r.baseline),
        JSON.stringify(r.result),
      ],
    );
    return rows[0].id;
  }
}
