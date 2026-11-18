import type { AnomalyFinding, AnomalyKind, AnomalyStatus } from '../api/anomalies';
import { formatDecimal, formatInt } from '../lib/format';
import { Badge } from './Badge';

export const KIND_LABEL: Record<AnomalyKind, string> = {
  SPIKE: 'Sales spike',
  DROP: 'Sales stopped',
  LARGE_WRITE_OFF: 'Large write-off',
  FREQUENT_ADJUSTMENTS: 'Repeated adjustments',
  HIGH_RETURN_RATE: 'Many returns',
};

const STATUS: Record<AnomalyStatus, { label: string; tone: 'neutral' | 'warn' | 'bad' | 'good' }> =
  {
    NEW: { label: 'New', tone: 'warn' },
    INVESTIGATING: { label: 'Investigating', tone: 'warn' },
    CONFIRMED: { label: 'Confirmed', tone: 'bad' },
    DISMISSED: { label: 'Dismissed', tone: 'neutral' },
    RESOLVED: { label: 'Resolved', tone: 'good' },
  };

export const STEP_LABEL: Record<AnomalyStatus, string> = {
  NEW: 'New',
  INVESTIGATING: 'Start investigating',
  CONFIRMED: 'Confirm it is real',
  DISMISSED: 'Dismiss (normal)',
  RESOLVED: 'Mark resolved',
};

export function AnomalyStatusBadge({ status }: { status: AnomalyStatus }) {
  return <Badge tone={STATUS[status].tone} label={STATUS[status].label} />;
}

export function SeverityBadge({ severity }: { severity: 'HIGH' | 'MEDIUM' }) {
  return <Badge tone={severity === 'HIGH' ? 'bad' : 'neutral'} label={severity.toLowerCase()} />;
}

/** "60 sold vs ~5 expected" — the numbers behind a finding, in words. */
export function observedText(f: AnomalyFinding): string {
  switch (f.kind) {
    case 'SPIKE':
      return `${formatInt(f.observed)} sold vs ~${formatDecimal(f.expected)} expected`;
    case 'DROP':
      return `0 sold in 3 days vs ~${formatDecimal(f.expected)} expected`;
    case 'LARGE_WRITE_OFF':
      return `${formatInt(f.observed)} units removed at once`;
    case 'FREQUENT_ADJUSTMENTS':
      return `${formatInt(f.observed)} reducing adjustments in a week`;
    case 'HIGH_RETURN_RATE':
      return `${formatInt(f.observed)} returns vs ${formatInt(Number(f.details?.saleLines ?? 0))} sales`;
  }
}

/** How much to trust a finding, from testing on synthetic data (docs/ARCHITECTURE.md §7.3). */
export function reliabilityText(f: Pick<AnomalyFinding, 'kind' | 'severity' | 'source'>): string {
  if (f.source === 'OPERATIONS') {
    return 'Found by a fixed rule on the stock ledger: the numbers above are exactly what the rule saw. Whether it is a problem needs a person.';
  }
  if (f.kind === 'DROP') {
    return 'In testing, about 1 in 5 flagged drops was a real problem; a genuine stock-out looks the same, so check stock and the shelf first.';
  }
  return f.severity === 'HIGH'
    ? 'In testing on synthetic data, about half of HIGH sales spikes were real (47–80 %). Worth a look.'
    : 'In testing, most MEDIUM sales spikes were normal variation (about 1 in 25 was real). Check only if something else looks wrong.';
}
