import { z } from 'zod';
import { paginationSchema, uuidSchema } from '../../core/http/query';

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
});
export type ListRecommendationsQuery = z.output<typeof listRecommendationsQuerySchema>;

export const decisionBodySchema = z.object({
  note: z.string().trim().min(1).max(200).optional(),
});
export type DecisionBody = z.output<typeof decisionBodySchema>;

/** Every input and intermediate number of a recommendation, stored as JSON for the "why" panel. */
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
  sigmaDaily: number;
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
  inputs: RecommendationInputs;
}
