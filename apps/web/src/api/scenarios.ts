import { getJson, postJson } from './client';

/** Totals of one replenishment batch (baseline or scenario), V2 4b. */
export interface BatchSummary {
  recommendations: number;
  byAction: { TRANSFER: number; PURCHASE_ORDER: number; REDISTRIBUTE_EXCESS: number };
  byRisk: { CRITICAL: number; HIGH: number };
  flaggedForReview: number;
  units: { TRANSFER: number; PURCHASE_ORDER: number; REDISTRIBUTE_EXCESS: number };
  transfersFromDc: number;
  fromStoreExcess: number;
  purchaseOrderValueAtCost: number;
  positions: number;
  outOfStockNow: number;
  stockoutWithin7: number;
  stockoutWithin14: number;
}

export interface ScenarioResult {
  id: string;
  scenarioId: string;
  forecastRunId: string;
  forecastHistoryEnd: string | null;
  runBy: string;
  runAt: string;
  durationMs: number;
  baseline: BatchSummary;
  result: BatchSummary;
}

export interface Scenario {
  id: string;
  name: string;
  description: string | null;
  demandPct: number;
  supplierLeadTimeDays: number;
  dcAvailabilityPct: number;
  createdBy: string;
  createdAt: string;
  latestResult: ScenarioResult | null;
}

export interface NewScenario {
  name: string;
  description?: string;
  demandPct: number;
  supplierLeadTimeDays: number;
  dcAvailabilityPct: number;
}

export const listScenarios = () => getJson<Scenario[]>('/scenarios');
export const createScenario = (body: NewScenario) => postJson<Scenario>('/scenarios', body);
export const runScenario = (id: string) => postJson<ScenarioResult>(`/scenarios/${id}/run`, {});
