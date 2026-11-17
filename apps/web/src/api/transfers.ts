import { getJson, type Page, postJson, qs } from './client';

export type TransferStatus = 'REQUESTED' | 'APPROVED' | 'DISPATCHED' | 'RECEIVED' | 'CANCELLED';
export const TRANSFER_STATUSES: TransferStatus[] = [
  'REQUESTED',
  'APPROVED',
  'DISPATCHED',
  'RECEIVED',
  'CANCELLED',
];

export interface TransferSummary {
  id: string;
  status: TransferStatus;
  notes: string | null;
  sourceLocationId: string;
  sourceCode: string;
  sourceName: string;
  destinationLocationId: string;
  destinationCode: string;
  destinationName: string;
  lineCount: number;
  totalUnits: number;
  requestedBy: string;
  requestedAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  dispatchedBy: string | null;
  dispatchedAt: string | null;
  receivedBy: string | null;
  receivedAt: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
}

export interface TransferLine {
  productId: string;
  sku: string;
  name: string;
  quantity: number;
}

export interface TransferDetail extends TransferSummary {
  lines: TransferLine[];
}

export const listTransfers = (p: { status?: TransferStatus; page?: number; pageSize?: number }) =>
  getJson<Page<TransferSummary>>(`/transfers${qs({ ...p })}`);

export const getTransfer = (id: string) => getJson<TransferDetail>(`/transfers/${id}`);

export const createTransfer = (
  body: {
    sourceLocationId: string;
    destinationLocationId: string;
    notes?: string;
    lines: { productId: string; quantity: number }[];
  },
  idempotencyKey: string,
) => postJson<TransferDetail>('/transfers', body, { idempotencyKey });

export type TransferStep = 'approve' | 'dispatch' | 'receive' | 'cancel';

export const transferStep = (id: string, step: TransferStep) =>
  postJson<TransferDetail>(`/transfers/${id}/${step}`, {});
