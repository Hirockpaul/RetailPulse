import type { PositionSummary, StoreHealth } from './overview.calc';
import type { DayUnits, LocationRow } from './overview.repository';

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
  /** Control Tower additions (V2 4a-1). Same scope as everything above. */
  controlTower: ControlTower;
}

export interface SupplierRisk {
  id: string;
  code: string;
  name: string;
  score: number | null;
  onTimeRate: number | null;
  /** Approved, unreceived purchase orders from this supplier into the caller's scope. */
  openPurchaseOrders: number;
}

export interface ControlTower {
  rules: { riskWindowLongDays: number; transferDelayDays: number; supplierRiskScore: number };
  kpis: {
    /** Every location in scope (stores, and DCs for roles that see the whole network). */
    onHand: number;
    available: number;
    valueAtCost: number;
    openTransfers: number;
    openAnomalies: number;
    excessValueAtCost: number;
  };
  risks: {
    atRisk7: number;
    atRisk14: number;
    excess: { positions: number; units: number; valueAtCost: number };
    delayedTransfers: number;
    overduePurchaseOrders: number;
    openAnomalies: number;
    openHighAnomalies: number;
    suppliersAtRisk: SupplierRisk[];
  };
  charts: {
    storeHealth: StoreHealth[];
    sales: { history: DayUnits[]; forecast: DayUnits[] };
    suppliers: SupplierRisk[];
  };
}

/** GET /overview/locations: one row per location in scope (V2 4a-1). */
export interface LocationHealth extends LocationRow {
  /** Stores only (DCs have no forecast): null for DCs. */
  outOfStock: number | null;
  atRisk: number | null;
  excess: number | null;
  excessValueAtCost: number | null;
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
