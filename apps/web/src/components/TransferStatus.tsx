import type { TransferStatus } from '../api/transfers';
import { Badge } from './Badge';

const TONE = {
  REQUESTED: 'neutral',
  APPROVED: 'warn',
  DISPATCHED: 'warn',
  RECEIVED: 'good',
  CANCELLED: 'bad',
} as const;

const LABEL: Record<TransferStatus, string> = {
  REQUESTED: 'Requested',
  APPROVED: 'Approved',
  DISPATCHED: 'In transit',
  RECEIVED: 'Received',
  CANCELLED: 'Cancelled',
};

export function TransferStatusBadge({ status }: { status: TransferStatus }) {
  return <Badge tone={TONE[status]} label={LABEL[status]} />;
}
