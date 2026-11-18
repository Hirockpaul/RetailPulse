import { z } from 'zod';
import { SCENARIO_LIMITS as L } from '../replenishment/replenishment.scenario';
import type { BatchSummary } from '../replenishment/replenishment.scenario';

export const createScenarioSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
  demandPct: z.number().int().min(L.demandPct.min).max(L.demandPct.max),
  supplierLeadTimeDays: z
    .number()
    .int()
    .min(L.supplierLeadTimeDays.min)
    .max(L.supplierLeadTimeDays.max),
  dcAvailabilityPct: z.number().int().min(L.dcAvailabilityPct.min).max(L.dcAvailabilityPct.max),
});
export type CreateScenario = z.output<typeof createScenarioSchema>;

export interface Scenario {
  id: string;
  name: string;
  description: string | null;
  demandPct: number;
  supplierLeadTimeDays: number;
  dcAvailabilityPct: number;
  createdBy: string;
  createdAt: Date;
}

export interface ScenarioResult {
  id: string;
  scenarioId: string;
  forecastRunId: string;
  forecastHistoryEnd: string | null;
  runBy: string;
  runAt: Date;
  durationMs: number;
  baseline: BatchSummary;
  result: BatchSummary;
}

export interface ScenarioListItem extends Scenario {
  latestResult: ScenarioResult | null;
}

export interface ScenarioDetail extends Scenario {
  results: ScenarioResult[];
}
