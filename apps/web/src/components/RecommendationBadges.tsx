import type {
  Recommendation,
  RecommendationStatus,
  ReviewReason,
  Risk,
} from '../api/replenishment';
import { Badge } from './Badge';

export function RiskBadge({ risk }: { risk: Risk | null }) {
  if (risk === null) return <Badge tone="neutral" label="Excess" />;
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

/** "Transfer from DC-NORTH" / "Order from <supplier>" / "Move excess to DC-SOUTH". */
export function actionLabel(
  r: Pick<Recommendation, 'action' | 'sourceCode' | 'supplierName' | 'destinationCode'>,
) {
  if (r.action === 'TRANSFER') return `Transfer from ${r.sourceCode}`;
  if (r.action === 'REDISTRIBUTE_EXCESS') return `Move excess to ${r.destinationCode}`;
  return `Order from ${r.supplierName ?? 'supplier'}`;
}

/** Why a manager must set the quantity (V2 2d-1), in words. */
export const REVIEW_REASON_TEXT: Record<ReviewReason, string> = {
  FALLBACK_FORECAST: 'little sales history: the forecast is only a category average',
  ERRATIC_DEMAND: 'erratic demand at this store (class Z)',
};

export function ReviewBadge({ reason }: { reason: ReviewReason | null }) {
  return reason ? <Badge tone="warn" label="Needs review" /> : null;
}
