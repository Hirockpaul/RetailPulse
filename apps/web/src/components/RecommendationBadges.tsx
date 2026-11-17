import type { Recommendation, RecommendationStatus, Risk } from '../api/replenishment';
import { Badge } from './Badge';

export function RiskBadge({ risk }: { risk: Risk }) {
  return risk === 'CRITICAL' ? (
    <Badge tone="bad" label="Critical" />
  ) : (
    <Badge tone="warn" label="High" />
  );
}

const STATUS_TONE: Record<RecommendationStatus, 'neutral' | 'good' | 'bad' | 'warn'> = {
  PENDING: 'warn',
  APPROVED: 'good',
  REJECTED: 'bad',
  EXPIRED: 'neutral',
};

export function RecommendationStatusBadge({ status }: { status: RecommendationStatus }) {
  return (
    <Badge tone={STATUS_TONE[status]} label={status.charAt(0) + status.slice(1).toLowerCase()} />
  );
}

/** "Transfer from DC-NORTH" / "Order from <supplier>". */
export function actionLabel(r: Pick<Recommendation, 'action' | 'sourceCode' | 'supplierName'>) {
  return r.action === 'TRANSFER'
    ? `Transfer from ${r.sourceCode}`
    : `Order from ${r.supplierName ?? 'supplier'}`;
}
