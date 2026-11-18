import { OPERATIONS_RULES as R } from './anomalies.config';

/**
 * Operational-anomaly rules as pure functions (unit-tested). Each returns a finding or null.
 * They describe what happened; they never decide that anyone did something wrong.
 */

export type OperationsKind = 'LARGE_WRITE_OFF' | 'FREQUENT_ADJUSTMENTS' | 'HIGH_RETURN_RATE';

export interface RuleFinding {
  kind: OperationsKind;
  severity: 'HIGH' | 'MEDIUM';
  score: number;
  observed: number;
  /** The rule's threshold, shown as "expected at most". */
  expected: number;
  explanation: string;
  details: Record<string, number | string>;
}

const pct = (x: number) => `${Math.round(x * 100)} %`;

/** One stock-reducing adjustment that removes a lot at once. */
export function largeWriteOff(onHandDelta: number, onHandAfter: number): RuleFinding | null {
  if (onHandDelta >= 0) return null;
  const removed = -onHandDelta;
  const before = onHandAfter + removed;
  const share = before > 0 ? removed / before : 0;
  const bigShare = before >= R.writeOffMinOnHand && share >= R.writeOffShare;
  if (removed < R.writeOffUnits && !bigShare) return null;
  const high = removed >= R.writeOffHighUnits || (bigShare && share >= R.writeOffHighShare);
  return {
    kind: 'LARGE_WRITE_OFF',
    severity: high ? 'HIGH' : 'MEDIUM',
    score: removed,
    observed: removed,
    expected: R.writeOffUnits,
    explanation:
      `One adjustment removed ${removed} units at once (${pct(share)} of the ${before} on hand). ` +
      `The rule flags ${R.writeOffUnits}+ units or ${pct(R.writeOffShare)}+ of stock. ` +
      'Check the reason given and whether a count, damage or loss explains it.',
    details: { removed, onHandBefore: before, onHandAfter, share: Math.round(share * 1000) / 1000 },
  };
}

/** Several stock-reducing adjustments of the same product at the same place in a short time. */
export function frequentAdjustments(countInWindow: number): RuleFinding | null {
  if (countInWindow < R.frequentAdjustments) return null;
  return {
    kind: 'FREQUENT_ADJUSTMENTS',
    severity: countInWindow >= R.frequentHigh ? 'HIGH' : 'MEDIUM',
    score: countInWindow,
    observed: countInWindow,
    expected: R.frequentAdjustments - 1,
    explanation:
      `${countInWindow} stock-reducing adjustments in ${R.frequentWindowDays} days for this product ` +
      `here (the rule flags ${R.frequentAdjustments} or more). Repeated corrections can mean a ` +
      'counting problem, shrinkage or a process issue.',
    details: { adjustments: countInWindow, windowDays: R.frequentWindowDays },
  };
}

/** Many returns compared with sales. Counts movements (damaged returns do not change stock). */
export function highReturnRate(returns: number, saleLines: number): RuleFinding | null {
  if (returns < R.returnMin) return null;
  const share = returns / Math.max(saleLines, 1);
  if (share < R.returnShare) return null;
  return {
    kind: 'HIGH_RETURN_RATE',
    severity: share >= R.returnHighShare ? 'HIGH' : 'MEDIUM',
    score: Math.round(share * 1000) / 1000,
    observed: returns,
    expected: Math.ceil(saleLines * R.returnShare),
    explanation:
      `${returns} returns against ${saleLines} sales in ${R.returnWindowDays} days ` +
      `(${pct(share)}; the rule flags ${pct(R.returnShare)}+ with at least ${R.returnMin} returns). ` +
      'Possible quality problem, wrong product description, or returns being misused.',
    details: {
      returns,
      saleLines,
      share: Math.round(share * 1000) / 1000,
      windowDays: R.returnWindowDays,
    },
  };
}
