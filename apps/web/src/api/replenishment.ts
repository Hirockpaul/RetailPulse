import { getJson, type Page, postJson, qs } from './client';

export type RecommendationStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
export type RecommendationAction = 'TRANSFER' | 'PURCHASE_ORDER';
export type Risk = 'CRITICAL' | 'HIGH';

export interface Recommendation {
  id: string;
  status: RecommendationStatus;
  action: RecommendationAction;
  quantity: number;
  risk: Risk;
  daysOfCover: number | null;
  generatedAt: string;
  forecastRunId: string;
  productId: string;
  sku: string;
  productName: string;
  packSize: number;
  locationId: string;
  locationCode: string;
  sourceLocationId: string | null;
  sourceCode: string | null;
  supplierId: string | null;
  supplierName: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  transferId: string | null;
  purchaseOrderId: string | null;
}

export interface RecommendationInputs {
  forecast: {
    model: string;
    isFallback: boolean;
    historyDays: number;
    testWape: number | null;
    demandDuringLead: number;
    demandDuringCover: number;
    avgDailyDemand: number;
    sigmaDaily: number;
  };
  parameters: {
    serviceLevelZ: number;
    reviewPeriodDays: number;
    leadTimeDays: number;
    leadTimeSource: 'transfer' | 'supplier';
    packSize: number;
    minOrderQty: number | null;
  };
  stock: { onHand: number; reserved: number; available: number; inbound: number; position: number };
  calculation: {
    safetyStock: number;
    reorderPoint: number;
    orderUpTo: number;
    rawQuantity: number;
    quantity: number;
    daysOfCover: number | null;
  };
  source: { code: string; availableNet: number } | null;
  supplier: { name: string; unitCost: number; leadTimeDays: number; minOrderQty: number } | null;
  dcShortfall: { code: string; availableNet: number; needed: number } | null;
}

export interface RecommendationDetail extends Recommendation {
  explanation: string;
  inputs: RecommendationInputs;
}

export interface GenerateResult {
  forecastRunId: string;
  forecastHistoryEnd: string | null;
  evaluated: number;
  created: number;
  expired: number;
  byAction: { TRANSFER: number; PURCHASE_ORDER: number };
  byRisk: { CRITICAL: number; HIGH: number };
  skipped: { noNeed: number; noSource: number };
}

export const listRecommendations = (p: {
  status?: RecommendationStatus;
  action?: RecommendationAction;
  risk?: Risk;
  page?: number;
  pageSize?: number;
}) => getJson<Page<Recommendation>>(`/replenishment/recommendations${qs({ ...p })}`);

export const getRecommendation = (id: string) =>
  getJson<RecommendationDetail>(`/replenishment/recommendations/${id}`);

export const generateRecommendations = () =>
  postJson<GenerateResult>('/replenishment/generate', {});

export const approveRecommendation = (id: string, note?: string) =>
  postJson<RecommendationDetail>(`/replenishment/recommendations/${id}/approve`, { note });

export const rejectRecommendation = (id: string, note?: string) =>
  postJson<RecommendationDetail>(`/replenishment/recommendations/${id}/reject`, { note });
