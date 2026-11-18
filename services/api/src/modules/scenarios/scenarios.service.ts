import { Injectable, NotFoundException } from '@nestjs/common';
import type { RequestContext } from '../../core/http/request-context';
import { ReplenishmentService } from '../replenishment/replenishment.service';
import { ScenariosRepository } from './scenarios.repository';
import type {
  CreateScenario,
  ScenarioDetail,
  ScenarioListItem,
  ScenarioResult,
} from './scenarios.schemas';

/**
 * What-if scenarios (V2 4b-1). Running one recomputes the replenishment batch in memory (baseline
 * and scenario, one snapshot) and stores a summary. It never creates a recommendation, transfer
 * or order and never moves stock.
 */
@Injectable()
export class ScenariosService {
  constructor(
    private readonly repo: ScenariosRepository,
    private readonly replenishment: ReplenishmentService,
  ) {}

  async create(body: CreateScenario, ctx: RequestContext): Promise<ScenarioDetail> {
    const id = await this.repo.create(body, ctx.user.id);
    return this.get(id);
  }

  async list(): Promise<ScenarioListItem[]> {
    const scenarios = await this.repo.list();
    const results = await this.repo.results(scenarios.map((s) => s.id));
    const latest = new Map<string, ScenarioResult>();
    for (const r of results) if (!latest.has(r.scenarioId)) latest.set(r.scenarioId, r);
    return scenarios.map((s) => ({ ...s, latestResult: latest.get(s.id) ?? null }));
  }

  async get(id: string): Promise<ScenarioDetail> {
    const scenario = await this.repo.find(id);
    if (!scenario) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Scenario not found.' });
    }
    return { ...scenario, results: await this.repo.results([id]) };
  }

  async run(id: string, ctx: RequestContext): Promise<ScenarioResult> {
    const scenario = await this.repo.find(id);
    if (!scenario) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Scenario not found.' });
    }
    const started = performance.now();
    const outcome = await this.replenishment.simulate(scenario);
    const resultId = await this.repo.saveResult({
      scenarioId: id,
      forecastRunId: outcome.forecastRunId,
      forecastHistoryEnd: outcome.forecastHistoryEnd,
      runBy: ctx.user.id,
      durationMs: Math.round(performance.now() - started),
      baseline: outcome.baseline,
      result: outcome.scenario,
    });
    return (await this.repo.results([id])).find((r) => r.id === resultId)!;
  }
}
