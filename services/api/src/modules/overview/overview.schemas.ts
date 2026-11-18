import type { PositionSummary } from './overview.calc';

/** GET /overview takes no input; this is its response. */
export interface Overview {
  /** When this overview was computed (stock numbers are as of this moment). */
  asOf: Date;
  /** Thresholds used, so the page can print them next to the numbers. */
  rules: { riskWindowDays: number; excessCoverDays: number };
  /** Stores this overview covers (store managers: their own stores). */
  storeCount: number;
  stock: PositionSummary;
  recommendations: {
    pending: number;
    byRisk: { CRITICAL: number; HIGH: number };
    byAction: { TRANSFER: number; PURCHASE_ORDER: number; REDISTRIBUTE_EXCESS: number };
    lastGeneratedAt: Date | null;
  };
  alerts: { open: number; byKind: { OUT_OF_STOCK: number; LOW_STOCK: number } };
  freshness: {
    /** Newest stock movement in scope (sale, receipt, transfer, …). */
    lastMovementAt: Date | null;
    /** The forecast that "at risk" and "excess" are based on; null if none has run. */
    forecast: {
      runId: string;
      finishedAt: Date | null;
      historyEnd: string | null;
      dataLabel: string | null;
      servedModel: string | null;
    } | null;
    /** Alerts are raised by the event worker: they are current up to the last processed event. */
    lastEventProcessedAt: Date | null;
    eventsWaiting: number;
  };
}

export interface RecommendationCounts {
  pending: number;
  critical: number;
  high: number;
  transfer: number;
  purchaseOrder: number;
  redistributeExcess: number;
  lastGeneratedAt: Date | null;
}

export interface AlertCounts {
  open: number;
  outOfStock: number;
  lowStock: number;
}
