import { getJson, type Page, postJson, qs } from './client';

export type PoStatus = 'APPROVED' | 'RECEIVED' | 'CANCELLED';

export interface PurchaseOrder {
  id: string;
  status: PoStatus;
  supplierName: string;
  destinationLocationId: string;
  destinationCode: string;
  expectedDate: string;
  notes: string | null;
  lineCount: number;
  totalUnits: number;
  totalCost: string;
  createdBy: string;
  createdAt: string;
  receivedBy: string | null;
  receivedAt: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
}

export interface PurchaseOrderDetail extends PurchaseOrder {
  lines: { productId: string; sku: string; name: string; quantity: number; unitCost: string }[];
}

export const listPurchaseOrders = (p: { status?: PoStatus; page?: number; pageSize?: number }) =>
  getJson<Page<PurchaseOrder>>(`/purchase-orders${qs({ ...p })}`);

export const getPurchaseOrder = (id: string) =>
  getJson<PurchaseOrderDetail>(`/purchase-orders/${id}`);

export const receivePurchaseOrder = (id: string) =>
  postJson<PurchaseOrderDetail>(`/purchase-orders/${id}/receive`, {});

export const cancelPurchaseOrder = (id: string) =>
  postJson<PurchaseOrderDetail>(`/purchase-orders/${id}/cancel`, {});
