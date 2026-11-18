/**
 * Supplier reliability score (V2 step 2c), fixed before measuring (docs/V2-PLAN.md):
 *   score = 50 × on-time rate + 30 × fill rate + 20 × (1 − min(lead-time CV, 1))   → 0..100
 * Plain arithmetic over delivery statistics; no ML (decision D6). Pure, unit-tested.
 */

export const MIN_DELIVERIES = 5;

export interface DeliveryStats {
  deliveries: number;
  meanLeadDays: number | null;
  medianLeadDays: number | null;
  stdLeadDays: number | null;
  onTimeRate: number | null;
  lateRate: number | null;
  avgDaysLate: number | null;
  fillRate: number | null;
  meanPromisedDays: number | null;
}

export interface ScoredStats extends DeliveryStats {
  /** 0-100, or null when there are too few deliveries to judge. */
  score: number | null;
  enoughData: boolean;
  /** One plain sentence for managers. */
  summary: string;
}

const pct = (x: number) => `${Math.round(x * 100)} %`;

export function score(s: DeliveryStats): ScoredStats {
  const enoughData = s.deliveries >= MIN_DELIVERIES;
  if (
    !enoughData ||
    s.onTimeRate === null ||
    s.fillRate === null ||
    s.meanLeadDays === null ||
    s.stdLeadDays === null
  ) {
    return {
      ...s,
      score: null,
      enoughData: false,
      summary: `Only ${s.deliveries} deliveries: too few to judge (needs ${MIN_DELIVERIES}).`,
    };
  }
  const cv = s.meanLeadDays > 0 ? s.stdLeadDays / s.meanLeadDays : 0;
  const value = 50 * s.onTimeRate + 30 * s.fillRate + 20 * (1 - Math.min(cv, 1));
  const late =
    s.lateRate && s.lateRate > 0 && s.avgDaysLate !== null
      ? `${pct(s.lateRate)} late by ${s.avgDaysLate.toFixed(1)} days on average`
      : 'never late';
  return {
    ...s,
    score: Math.round(value * 10) / 10,
    enoughData: true,
    summary:
      `${pct(s.onTimeRate)} on time (${late}); ${pct(s.fillRate)} of ordered units delivered; ` +
      `lead time ${s.meanLeadDays.toFixed(1)} ± ${s.stdLeadDays.toFixed(1)} days.`,
  };
}
