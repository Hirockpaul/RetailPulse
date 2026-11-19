import { z } from 'zod';
import type { AiClaim, AiProvider } from '../../core/ai/ai.types';
import { paginationSchema, uuidSchema } from '../../core/http/query';

export const REPORT_KINDS = ['DAILY', 'WEEKLY'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

export const generateReportSchema = z.object({
  kind: z.enum(REPORT_KINDS),
  /** Omitted = the whole network. */
  locationId: uuidSchema.optional(),
  /** Last day of the period (UTC). Omitted = yesterday. */
  periodEnd: isoDay.optional(),
});
export type GenerateReport = z.output<typeof generateReportSchema>;

export const listReportsQuerySchema = paginationSchema.extend({
  kind: z.enum(REPORT_KINDS).optional(),
  locationId: uuidSchema.optional(),
});
export type ListReportsQuery = z.output<typeof listReportsQuerySchema>;

/** The frozen snapshot stored in report_runs.content. */
export interface ReportContent {
  kind: ReportKind;
  periodStart: string;
  periodEnd: string;
  scope: { locationId: string; code: string; name: string; type: string } | null;
  generatedAt: string;
  dataLabel: 'SYNTHETIC';
  sales: {
    unitsSold: number;
    unitsReturned: number;
    /** Units sold × the product's unit price when the report was generated. */
    salesValueAtPrice: number;
    byStore: { locationId: string; code: string; unitsSold: number; valueAtPrice: number }[];
    topProducts: {
      productId: string;
      sku: string;
      name: string;
      unitsSold: number;
      valueAtPrice: number;
    }[];
  };
  movements: {
    receipts: number;
    transfersIn: number;
    transfersOut: number;
    returns: number;
    adjustmentsNet: number;
    adjustmentsRemoved: number;
  };
  work: {
    transfersRequested: number;
    transfersDispatched: number;
    transfersReceived: number;
    purchaseOrdersCreated: number;
    purchaseOrdersReceived: number;
    recommendationsGenerated: number;
    recommendationsApproved: number;
    recommendationsRejected: number;
    alertsOpened: number;
    anomaliesFound: number;
    anomaliesReviewed: number;
  };
  /** Control Tower figures for the same scope at generation time (not at period end). */
  stockAtGeneration: {
    asOf: string;
    positions: number;
    onHand: number;
    available: number;
    valueAtCost: number;
    outOfStock: number;
    atRisk7: number | null;
    atRisk14: number | null;
    excessPositions: number | null;
    excessValueAtCost: number | null;
  };
}

export interface ReportSummary {
  id: string;
  kind: ReportKind;
  periodStart: string;
  periodEnd: string;
  locationId: string | null;
  locationCode: string | null;
  trigger: 'MANUAL' | 'SCHEDULED';
  generatedBy: string | null;
  generatedAt: Date;
  durationMs: number;
}

export interface ReportDetail extends ReportSummary {
  content: ReportContent;
}

export interface ReportWords {
  source: 'ai' | 'template';
  provider?: AiProvider;
  claims: AiClaim[];
}
