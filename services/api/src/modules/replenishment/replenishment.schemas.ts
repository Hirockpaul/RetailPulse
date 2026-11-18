import { z } from 'zod';
import { paginationSchema, uuidSchema } from '../../core/http/query';
import type { ReviewReason } from './replenishment.calc';

export const RECOMMENDATION_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'] as const;
export type RecommendationStatus = (typeof RECOMMENDATION_STATUSES)[number];
export const RECOMMENDATION_ACTIONS = ['TRANSFER', 'PURCHASE_ORDER'] as const;
export const RISKS = ['CRITICAL', 'HIGH'] as const;

export const listRecommendationsQuerySchema = paginationSchema.extend({
  status: z.enum(RECOMMENDATION_STATUSES).optional(),
  action: z.enum(RECOMMENDATION_ACTIONS).optional(),
  risk: z.enum(RISKS).optional(),
  locationId: uuidSchema.optional(),
  productId: uuidSchema.optional(),
  /** true = only recommendations flagged for manual review. */
  needsReview: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
export type ListRecommendationsQuery = z.output<typeof listRecommendationsQuerySchema>;

export const decisionBodySchema = z.object({
  note: z.string().trim().min(1).max(200).optional(),
});
export type DecisionBody = z.output<typeof decisionBodySchema>;

/** Approving: `quantity` is required for (and only accepted on) a flagged recommendation. */
export const approveBodySchema = decisionBodySchema.extend({
  quantity: z.number().int().min(1).max(100_000).optional(),
});
export type ApproveBody = z.output<typeof approveBodySchema>;

export const statusQuerySchema = z.object({ productId: uuidSchema });

/** Per store: does this product need anything now? (V2 2d-1, computed on request, not stored) */
export interface ProductStatus {
  forecastRunId: string | null;
  historyEnd: string | null;
  stores: {
    locationId: string;
    locationCode: string;
    available: number;
    inbound: number;
    position: number;
    outcome: 'NO_ACTION_REQUIRED' | 'NEEDS_STOCK' | 'NO_SOURCE';
    reorderPoint: number | null;
    suggestedQuantity: number | null;
    suggestedAction: 'TRANSFER' | 'PURCHASE_ORDER' | null;
    serviceLevel: number;
    cls: string | null;
    reviewReason: ReviewReason | null;
    expectedStockoutOn: string | null;
    stockoutBeyondForecast: boolean;
    outOfStockNow: boolean;
    isFallback: boolean;
    pending: PendingRef | null;
  }[];
}

export interface PendingRef {
  id: string;
  action: 'TRANSFER' | 'PURCHASE_ORDER';
  quantity: number;
  risk: 'CRITICAL' | 'HIGH';
  reviewReason: ReviewReason | null;
}

/**
 * Every input and intermediate number of a recommendation, stored as JSON for the "why" panel.
 * Fields marked "v2" exist on recommendations generated since V2 step 2b (safety stock v2);
 * older rows have `sigmaDaily` (the spread of demand) in place of `sigmaError`.
 */
export interface RecommendationInputs {
  forecast: {
    runId: string;
    model: string;
    isFallback: boolean;
    historyDays: number;
    /** Backtest WAPE of this series' forecast (null if it had too little history to measure). */
    testWape: number | null;
    demandDuringLead: number;
    demandDuringCover: number;
    avgDailyDemand: number;
    /** v1 only: standard deviation of daily demand (last 90 days). */
    sigmaDaily?: number;
    /** v2: the forecast's typical daily error (backtest root-mean-square error). */
    sigmaError?: number;
  };
  parameters: {
    /** v2: target share of cycles without a stock-out, from the ABC/XYZ class. */
    serviceLevel?: number;
    /** v2: the product's class at this store in the latest ABC/XYZ run (null = none yet). */
    classification?: { cls: string | null; runId: string | null };
    serviceLevelZ: number;
    reviewPeriodDays: number;
    leadTimeDays: number;
    leadTimeSource: 'transfer' | 'supplier';
    /** v2: lead-time spread σL and where L and σL come from. */
    leadTimeStdDays?: number;
    leadTimeBasis?: 'transfer' | 'measured' | 'promised';
    supplierDeliveries?: number | null;
    packSize: number;
    minOrderQty: number | null;
  };
  stock: { onHand: number; reserved: number; available: number; inbound: number; position: number };
  calculation: {
    safetyStock: number;
    /** v2: the two parts under the square root (L·σe² and d²·σL²). */
    safetyStockParts?: { demandVariance: number; leadTimeVariance: number };
    reorderPoint: number;
    orderUpTo: number;
    rawQuantity: number;
    quantity: number;
    daysOfCover: number | null;
  };
  /** v2 (2d-1): expected stockout and the manual-review reason. */
  stockout?: { day: number | null; date: string | null; beyondForecast: boolean };
  review?: ReviewReason | null;
  source: { code: string; availableNet: number } | null;
  supplier: {
    id: string;
    name: string;
    unitCost: number;
    leadTimeDays: number;
    minOrderQty: number;
  } | null;
  dcShortfall: { code: string; availableNet: number; needed: number } | null;
}

export interface RecommendationSummary {
  id: string;
  status: RecommendationStatus;
  action: 'TRANSFER' | 'PURCHASE_ORDER';
  quantity: number;
  risk: 'CRITICAL' | 'HIGH';
  daysOfCover: number | null;
  expectedStockoutOn: string | null;
  reviewReason: ReviewReason | null;
  /** The quantity actually approved (null unless APPROVED; null for approvals before 2d-1). */
  approvedQuantity: number | null;
  generatedAt: Date;
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
  decidedAt: Date | null;
  decisionNote: string | null;
  transferId: string | null;
  purchaseOrderId: string | null;
}

export interface RecommendationDetail extends RecommendationSummary {
  explanation: string;
  inputs: RecommendationInputs;
}

/** One product at one store, with everything the calculation needs. */
export interface PairRow {
  productId: string;
  locationId: string;
  locationCode: string;
  sku: string;
  productName: string;
  packSize: number;
  model: string;
  isFallback: boolean;
  historyDays: number;
  testWape: number | null;
  /** The forecast's typical daily error (forecast.series.sigma). */
  sigmaError: number;
  yhat: number[];
  onHand: number;
  reserved: number;
  inbound: number;
  supplierId: string | null;
  supplierName: string | null;
  leadTimeDays: number | null;
  minOrderQty: number | null;
  unitCost: number | null;
}

export interface NewRecommendation {
  forecastRunId: string;
  productId: string;
  locationId: string;
  action: 'TRANSFER' | 'PURCHASE_ORDER';
  sourceLocationId: string | null;
  supplierId: string | null;
  quantity: number;
  risk: 'CRITICAL' | 'HIGH';
  daysOfCover: number | null;
  expectedStockoutOn: string | null;
  reviewReason: ReviewReason | null;
  inputs: RecommendationInputs;
  explanation: string;
}

export interface LockedRecommendation {
  status: RecommendationStatus;
  action: 'TRANSFER' | 'PURCHASE_ORDER';
  productId: string;
  locationId: string;
  sourceLocationId: string | null;
  supplierId: string | null;
  quantity: number;
  reviewReason: ReviewReason | null;
  inputs: RecommendationInputs;
}
