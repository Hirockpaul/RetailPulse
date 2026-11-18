import { getJson, type Page, postJson, qs } from './client';

export type ReportKind = 'DAILY' | 'WEEKLY';

export interface ReportSummary {
  id: string;
  kind: ReportKind;
  periodStart: string;
  periodEnd: string;
  locationId: string | null;
  locationCode: string | null;
  trigger: 'MANUAL' | 'SCHEDULED';
  generatedBy: string | null;
  generatedAt: string;
  durationMs: number;
}

/** The frozen snapshot (V2 4c). */
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

export interface ReportDetail extends ReportSummary {
  content: ReportContent;
}

export const listReports = (p: { page?: number; kind?: ReportKind }) =>
  getJson<Page<ReportSummary>>(`/reports${qs({ pageSize: 20, ...p })}`);
export const getReport = (id: string) => getJson<ReportDetail>(`/reports/${id}`);
export const generateReport = (body: {
  kind: ReportKind;
  locationId?: string;
  periodEnd?: string;
}) => postJson<ReportDetail>('/reports/generate', body);
/** Same-origin download: the session cookie goes with it. */
export const reportCsvUrl = (id: string) => `/api/v1/reports/${id}/export.csv`;
