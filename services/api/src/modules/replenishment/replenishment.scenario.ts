/**
 * What-if scenarios (V2 4b-1): adjust a loaded batch snapshot, and summarize a computed batch.
 * Pure functions, no I/O. Rules fixed before building: docs/V2-PLAN.md step 4b-1.
 *
 *   demandPct            every forecast value and the forecast error σe × (1 + p / 100)
 *   supplierLeadTimeDays + n days on every supplier's promised lead time (measured delays still apply)
 *   dcAvailabilityPct    DC stock usable for transfers × (1 − p / 100), rounded down
 */
import type { BatchInputs, BatchStats, GenerateResult } from './replenishment.service';
import type { NewRecommendation, PairRow } from './replenishment.schemas';

export interface ScenarioAdjustments {
  demandPct: number;
  supplierLeadTimeDays: number;
  dcAvailabilityPct: number;
}

export const SCENARIO_LIMITS = {
  demandPct: { min: -50, max: 200 },
  supplierLeadTimeDays: { min: 0, max: 30 },
  dcAvailabilityPct: { min: 0, max: 100 },
} as const;

/** A new snapshot with the adjustments applied; the input is never modified. */
export function applyScenario(inputs: BatchInputs, a: ScenarioAdjustments): BatchInputs {
  const factor = 1 + a.demandPct / 100;
  const keep = 1 - a.dcAvailabilityPct / 100;
  const pairs: PairRow[] = inputs.pairs.map((p) => ({
    ...p,
    yhat: p.yhat.map((v) => v * factor),
    sigmaError: p.sigmaError * factor,
    leadTimeDays: p.leadTimeDays === null ? null : p.leadTimeDays + a.supplierLeadTimeDays,
  }));
  const dcByProduct = new Map(
    [...inputs.dcByProduct].map(([product, dcs]) => [
      product,
      dcs.map((d) => ({ ...d, availableNet: Math.floor(d.availableNet * keep) })),
    ]),
  );
  return { ...inputs, pairs, dcByProduct };
}

export interface BatchSummary {
  recommendations: number;
  byAction: { TRANSFER: number; PURCHASE_ORDER: number; REDISTRIBUTE_EXCESS: number };
  byRisk: { CRITICAL: number; HIGH: number };
  flaggedForReview: number;
  units: { TRANSFER: number; PURCHASE_ORDER: number; REDISTRIBUTE_EXCESS: number };
  /** Transfers sourced from a distribution centre (the rest come from store excess). */
  transfersFromDc: number;
  fromStoreExcess: number;
  /** Purchase-order units × the supplier unit cost stored with each recommendation. */
  purchaseOrderValueAtCost: number;
  positions: number;
  outOfStockNow: number;
  stockoutWithin7: number;
  stockoutWithin14: number;
}

export function summarizeBatch(
  batch: { recommendations: NewRecommendation[]; result: GenerateResult; stats: BatchStats },
  pairs: PairRow[],
): BatchSummary {
  const units = { TRANSFER: 0, PURCHASE_ORDER: 0, REDISTRIBUTE_EXCESS: 0 };
  let flagged = 0;
  let poValue = 0;
  let transfersFromDc = 0;
  for (const r of batch.recommendations) {
    units[r.action] += r.quantity;
    if (r.reviewReason) flagged++;
    if (r.action === 'PURCHASE_ORDER' && r.inputs.kind !== 'EXCESS' && r.inputs.supplier) {
      poValue += r.quantity * r.inputs.supplier.unitCost;
    }
    if (
      r.action === 'TRANSFER' &&
      r.inputs.kind !== 'EXCESS' &&
      r.inputs.source?.kind !== 'STORE'
    ) {
      transfersFromDc++;
    }
  }
  return {
    recommendations: batch.recommendations.length,
    byAction: { ...batch.result.byAction },
    byRisk: { ...batch.result.byRisk },
    flaggedForReview: flagged,
    units,
    transfersFromDc,
    fromStoreExcess: batch.result.fromStoreExcess,
    purchaseOrderValueAtCost: Math.round(poValue * 100) / 100,
    positions: pairs.length,
    ...batch.stats,
  };
}
