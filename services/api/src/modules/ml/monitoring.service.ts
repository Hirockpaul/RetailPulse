import { Injectable } from '@nestjs/common';
import { ForecastClient } from '../forecasts/forecast.client';
import { runHealth } from './monitoring.health';
import {
  type MonitoringResultRow,
  MonitoringRepository,
  type MonitoringRunRow,
} from './monitoring.repository';

/** Thresholds in words, from docs/V2-PLAN.md step 3c-1 (the service applies them). */
const RULES = {
  windowDays: 28,
  minCurrentDays: 7,
  psiWatch: 0.1,
  psiDrift: 0.25,
  degradedWapeGap: 0.05,
  degradedAbsBias: 0.1,
  minAccuracyDays: 7,
  minAccuracyPoints: 1000,
  text: [
    'Reference = the 28 days up to the active model’s training end; current = complete days after it (latest 28). Fewer than 7 new days: not enough data to judge.',
    'PSI (population stability index) sets the status: below 0.10 stable, 0.10–0.25 watch, 0.25 or more drift. KS is shown for context only.',
    'Accuracy on new days is degraded when its WAPE exceeds the backtest test WAPE by more than 5 points, or bias is beyond ±10 % (needs 7 days and 1,000 forecasts).',
    'Monitoring only describes the model. It never retrains, activates or rolls back anything.',
  ],
} as const;

export interface MonitoringOverview {
  health: ReturnType<typeof runHealth>;
  latest: (MonitoringRunRow & { results: MonitoringResultRow[] }) | null;
  recent: MonitoringRunRow[];
  rules: typeof RULES;
}

/** Model monitoring (V2 3c-2): read the service's results, compute run health, run on demand. */
@Injectable()
export class MonitoringService {
  constructor(
    private readonly repo: MonitoringRepository,
    private readonly client: ForecastClient,
  ) {}

  async overview(): Promise<MonitoringOverview> {
    const [recent, latestOk, inputs] = await Promise.all([
      this.repo.recent(),
      this.repo.latestSucceeded(),
      this.repo.healthInputs(),
    ]);
    const health = runHealth({
      ...inputs,
      latestMonitoring: recent[0] ?? null,
      latestSucceededMonitoring: latestOk,
    });
    return {
      health,
      latest: latestOk ? { ...latestOk, results: await this.repo.results(latestOk.id) } : null,
      recent,
      rules: RULES,
    };
  }

  async run(correlationId?: string): Promise<MonitoringOverview> {
    await this.client.runMonitoring(correlationId);
    return this.overview();
  }
}
