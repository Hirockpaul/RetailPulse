import { getJson, type Page, postJson, qs } from './client';

export type RecommendationStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
export type RecommendationAction = 'TRANSFER' | 'PURCHASE_ORDER' | 'REDISTRIBUTE_EXCESS';
export type Risk = 'CRITICAL' | 'HIGH';
/** Why a manager must set the quantity (V2 2d-1). */
export type ReviewReason = 'FALLBACK_FORECAST' | 'ERRATIC_DEMAND';

export interface Recommendation {
  id: string;
  status: RecommendationStatus;
  action: RecommendationAction;
  quantity: number;
  risk: Risk | null;
  daysOfCover: number | null;
  /** First day with unmet demand at the forecast rate (null: not within 90 days / before 2d-1). */
  expectedStockoutOn: string | null;
  reviewReason: ReviewReason | null;
  approvedQuantity: number | null;
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
  destinationLocationId: string | null;
  destinationCode: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  transferId: string | null;
  purchaseOrderId: string | null;
}

export interface NeedInputs {
  kind?: undefined;
  forecast: {
    model: string;
    isFallback: boolean;
    historyDays: number;
    testWape: number | null;
    demandDuringLead: number;
    demandDuringCover: number;
    avgDailyDemand: number;
    /** Recommendations before V2 2b: spread of daily demand. */
    sigmaDaily?: number;
    /** Since V2 2b: the forecast's typical daily error. */
    sigmaError?: number;
  };
  parameters: {
    serviceLevel?: number;
    classification?: { cls: string | null; runId: string | null };
    serviceLevelZ: number;
    reviewPeriodDays: number;
    leadTimeDays: number;
    leadTimeSource: 'transfer' | 'supplier';
    leadTimeStdDays?: number;
    leadTimeBasis?: 'transfer' | 'measured' | 'promised';
    supplierDeliveries?: number | null;
    packSize: number;
    minOrderQty: number | null;
  };
  stock: { onHand: number; reserved: number; available: number; inbound: number; position: number };
  calculation: {
    safetyStock: number;
    safetyStockParts?: { demandVariance: number; leadTimeVariance: number };
    reorderPoint: number;
    orderUpTo: number;
    rawQuantity: number;
    quantity: number;
    daysOfCover: number | null;
  };
  stockout?: { day: number | null; date: string | null; beyondForecast: boolean };
  review?: ReviewReason | null;
  source: { code: string; availableNet: number; kind?: 'DC' | 'STORE' } | null;
  supplier: { name: string; unitCost: number; leadTimeDays: number; minOrderQty: number } | null;
  dcShortfall: { code: string; availableNet: number; needed: number } | null;
}

export interface ExcessInputs {
  kind: 'EXCESS';
  forecast: {
    model: string;
    isFallback: boolean;
    historyDays: number;
    testWape: number | null;
    avgDailyDemand: number;
  };
  stock: {
    onHand: number;
    reserved: number;
    available: number;
    inbound: number;
    position: number;
    promisedOut: number;
  };
  excess: {
    keepDays: number;
    demandKeep: number;
    reorderPoint: number;
    keep: number;
    excess: number;
    movable: number;
    packSize: number;
  };
  destination: { code: string; available: number };
}

export type RecommendationInputs = NeedInputs | ExcessInputs;

export interface RecommendationDetail extends Recommendation {
  explanation: string;
  inputs: RecommendationInputs;
}

export interface RecommendationWords {
  source: 'ai' | 'template';
  claims: {
    type: 'fact' | 'prediction' | 'estimate' | 'recommendation' | 'unknown';
    text: string;
  }[];
}

export interface GenerateResult {
  forecastRunId: string;
  forecastHistoryEnd: string | null;
  evaluated: number;
  created: number;
  expired: number;
  byAction: { TRANSFER: number; PURCHASE_ORDER: number; REDISTRIBUTE_EXCESS: number };
  byRisk: { CRITICAL: number; HIGH: number };
  fromStoreExcess: number;
  skipped: { noNeed: number; noSource: number };
}

export const listRecommendations = (p: {
  status?: RecommendationStatus;
  action?: RecommendationAction;
  risk?: Risk;
  needsReview?: boolean;
  page?: number;
  pageSize?: number;
}) =>
  getJson<Page<Recommendation>>(
    `/replenishment/recommendations${qs({
      ...p,
      needsReview: p.needsReview === undefined ? undefined : String(p.needsReview),
    })}`,
  );

export const getRecommendation = (id: string) =>
  getJson<RecommendationDetail>(`/replenishment/recommendations/${id}`);

export const fetchRecommendationWords = (id: string) =>
  postJson<RecommendationWords>(`/replenishment/recommendations/${id}/explanation/words`, {});

export const generateRecommendations = () =>
  postJson<GenerateResult>('/replenishment/generate', {});

/** `quantity` only for recommendations flagged for review (then it and a note are required). */
export const approveRecommendation = (id: string, note?: string, quantity?: number) =>
  postJson<RecommendationDetail>(`/replenishment/recommendations/${id}/approve`, {
    note,
    quantity,
  });

export interface StoreStatus {
  locationId: string;
  locationCode: string;
  available: number;
  inbound: number;
  position: number;
  outcome: 'NO_ACTION_REQUIRED' | 'NEEDS_STOCK' | 'NO_SOURCE' | 'EXCESS';
  movableExcess: number | null;
  reorderPoint: number | null;
  suggestedQuantity: number | null;
  suggestedAction: RecommendationAction | null;
  serviceLevel: number;
  cls: string | null;
  reviewReason: ReviewReason | null;
  expectedStockoutOn: string | null;
  stockoutBeyondForecast: boolean;
  outOfStockNow: boolean;
  isFallback: boolean;
  pending: {
    id: string;
    action: RecommendationAction;
    quantity: number;
    risk: Risk | null;
    reviewReason: ReviewReason | null;
  } | null;
}

export interface ProductStatus {
  forecastRunId: string | null;
  historyEnd: string | null;
  stores: StoreStatus[];
}

/** Per store, does this product need anything now? (computed on request, nothing stored) */
export const getReplenishmentStatus = (productId: string) =>
  getJson<ProductStatus>(`/replenishment/status${qs({ productId })}`);

export const rejectRecommendation = (id: string, note?: string) =>
  postJson<RecommendationDetail>(`/replenishment/recommendations/${id}/reject`, { note });
