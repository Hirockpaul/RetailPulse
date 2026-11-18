import { getJson } from './client';

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
  score: number | null;
  enoughData: boolean;
  summary: string;
}

export interface SupplierPerformance extends DeliveryStats {
  id: string;
  code: string;
  name: string;
  products: number;
  synthetic: number;
  lastDelivery: string | null;
}

export interface SupplierDetail extends SupplierPerformance {
  productStats: (DeliveryStats & {
    productId: string;
    sku: string;
    productName: string;
    promisedDays: number | null;
  })[];
  recent: {
    orderedOn: string;
    receivedOn: string;
    promisedDays: number;
    leadDays: number;
    orderedQty: number;
    receivedQty: number;
    sku: string;
    locationCode: string;
    source: 'SYNTHETIC' | 'ORDER';
  }[];
  rules: { minDeliveries: number; score: string };
}

export const listSupplierPerformance = () =>
  getJson<SupplierPerformance[]>('/suppliers/performance');
export const getSupplierPerformance = (id: string) =>
  getJson<SupplierDetail>(`/suppliers/${id}/performance`);
