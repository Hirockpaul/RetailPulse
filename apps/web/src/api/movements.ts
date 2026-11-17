import { getJson, type Page, postJson, qs } from './client';

export interface MovementResult {
  ledgerId: string;
  productId: string;
  locationId: string;
  movementType: string;
  onHandDelta: number;
  reservedDelta: number;
  onHandAfter: number;
  reservedAfter: number;
  occurredAt: string;
}

export interface SalesOrder {
  id: string;
  locationId: string;
  totalAmount: string;
  createdAt: string;
  lines: { productId: string; sku: string; quantity: number; unitPrice: string }[];
}

export interface Reservation {
  id: string;
  productId: string;
  sku: string;
  locationId: string;
  locationCode: string;
  quantity: number;
  status: 'ACTIVE' | 'RELEASED';
  reference: string | null;
  createdAt: string;
  releasedAt: string | null;
}

type Key = { idempotencyKey: string };

export const recordSale = (
  b: { locationId: string; lines: { productId: string; quantity: number }[] },
  k: Key,
) => postJson<SalesOrder>('/sales', b, k);

export const recordReceipt = (
  b: {
    locationId: string;
    reference?: string;
    lines: { productId: string; quantity: number }[];
  },
  k: Key,
) => postJson<{ data: MovementResult[] }>('/receipts', b, k);

export const recordReturn = (
  b: {
    locationId: string;
    productId: string;
    quantity: number;
    condition: 'SELLABLE' | 'DAMAGED';
    reason?: string;
  },
  k: Key,
) => postJson<{ data: MovementResult[] }>('/returns', b, k);

export const recordAdjustment = (
  b: { locationId: string; productId: string; delta: number; reason: string },
  k: Key,
) => postJson<{ data: MovementResult[] }>('/adjustments', b, k);

export const createReservation = (
  b: { locationId: string; productId: string; quantity: number; reference?: string },
  k: Key,
) => postJson<Reservation>('/reservations', b, k);

export const releaseReservation = (id: string) =>
  postJson<Reservation>(`/reservations/${id}/release`, {});

export const listReservations = (p: {
  productId?: string;
  status?: 'ACTIVE' | 'RELEASED';
  page?: number;
  pageSize?: number;
}) => getJson<Page<Reservation>>(`/reservations${qs({ ...p })}`);
