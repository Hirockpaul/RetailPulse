import type { AiAnswer, AiFact } from '../../core/ai/ai.types';
import type { AnomalyFinding } from './anomalies.schemas';

const one = (value: number) => Math.round(value * 10) / 10;

const KIND_LABEL: Record<AnomalyFinding['kind'], string> = {
  SPIKE: 'sales spike',
  DROP: 'sales drop',
  LARGE_WRITE_OFF: 'large write-off',
  FREQUENT_ADJUSTMENTS: 'frequent stock adjustments',
  HIGH_RETURN_RATE: 'high return rate',
};

const CHECKS: Record<AnomalyFinding['kind'], string> = {
  SPIKE:
    'Check for a promotion or local event, duplicate sales records, and whether the stock count supports the recorded sales.',
  DROP: 'Check for a stock-out, shelf availability problem, store closure, or a gap in sales recording.',
  LARGE_WRITE_OFF:
    'Check the adjustment reason, the physical count, and whether damage or loss explains the write-off.',
  FREQUENT_ADJUSTMENTS:
    'Check recent counts and movement records for repeated corrections, process gaps, or shrinkage.',
  HIGH_RETURN_RATE:
    'Check product quality, product descriptions, return reasons, and whether returns were recorded correctly.',
};

export function anomalyWords(finding: AnomalyFinding): { facts: AiFact[]; template: AiAnswer } {
  const observed = one(finding.observed);
  const expected = one(finding.expected);
  const score = one(finding.score);
  const kind = KIND_LABEL[finding.kind];
  const comparison =
    finding.source === 'SALES'
      ? `${observed} units were recorded; the historical comparison expected about ${expected} units.`
      : `${observed} were observed; the operational rule's comparison threshold was ${expected}.`;

  const facts: AiFact[] = [
    { id: 'product', label: 'Product name', value: finding.productName },
    { id: 'store', label: 'Store code', value: finding.locationCode },
    { id: 'day', label: 'Finding day', value: finding.day },
    { id: 'source', label: 'Finding source', value: finding.source },
    { id: 'kind', label: 'Finding kind', value: kind },
    { id: 'severity', label: 'Finding severity', value: finding.severity },
    { id: 'observed', label: 'Observed value', value: observed },
    { id: 'expected', label: 'Expected or rule-threshold value', value: expected },
    { id: 'score', label: 'Finding score', value: score },
    { id: 'checks', label: 'Backend-selected checks', value: CHECKS[finding.kind] },
  ];

  return {
    facts,
    template: {
      claims: [
        {
          type: 'fact',
          text: `${finding.productName} at ${finding.locationCode} was flagged on ${finding.day}. ${comparison}`,
        },
        {
          type: 'fact',
          text: `RetailPulse classified this as a ${kind} with ${finding.severity} severity and a score of ${score}.`,
        },
        {
          type: 'unknown',
          text: 'The flag is a signal to investigate, not proof of a problem or its cause.',
        },
        {
          type: 'recommendation',
          text: `${CHECKS[finding.kind]} Reviewing the finding records a decision only and does not change stock.`,
        },
      ],
    },
  };
}
