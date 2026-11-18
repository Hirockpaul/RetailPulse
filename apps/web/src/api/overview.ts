import { getJson } from './client';

export interface PositionItem {
  productId: string;
  sku: string;
  productName: string;
  locationId: string;
  locationCode: string;
  available: number;
  inbound: number;
  demandWindow: number;
  daysOfCover: number | null;
  excessUnits?: number;
}

export interface Overview {
  asOf: string;
  rules: { riskWindowDays: number; excessCoverDays: number };
  storeCount: number;
  stock: {
    positions: number;
    withoutForecast: number;
    outOfStock: number;
    atRisk: number;
    excess: number;
    excessUnits: number;
    atRiskTop: PositionItem[];
    excessTop: PositionItem[];
  };
  recommendations: {
    pending: number;
    byRisk: { CRITICAL: number; HIGH: number };
    byAction: { TRANSFER: number; PURCHASE_ORDER: number; REDISTRIBUTE_EXCESS: number };
    lastGeneratedAt: string | null;
  };
  alerts: { open: number; byKind: { OUT_OF_STOCK: number; LOW_STOCK: number } };
  freshness: {
    lastMovementAt: string | null;
    forecast: {
      runId: string;
      finishedAt: string | null;
      historyEnd: string | null;
      dataLabel: string | null;
      servedModel: string | null;
    } | null;
    lastEventProcessedAt: string | null;
    eventsWaiting: number;
  };
  /** Control Tower additions (V2 4a). */
  controlTower: ControlTower;
}

export interface StoreHealth {
  locationId: string;
  locationCode: string;
  outOfStock: number;
  noForecast: number;
  atRisk: number;
  excess: number;
  healthy: number;
  excessUnits: number;
  excessValue: number;
}

export interface SupplierRisk {
  id: string;
  code: string;
  name: string;
  score: number | null;
  onTimeRate: number | null;
  openPurchaseOrders: number;
}

export interface DayUnits {
  day: string;
  units: number;
}

export interface ControlTower {
  rules: { riskWindowLongDays: number; transferDelayDays: number; supplierRiskScore: number };
  kpis: {
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

export interface LocationHealth {
  locationId: string;
  locationCode: string;
  locationName: string;
  locationType: 'STORE' | 'DISTRIBUTION_CENTER';
  onHand: number;
  available: number;
  valueAtCost: number;
  pendingRecommendations: number;
  openAlerts: number;
  openAnomalies: number;
  transfersIn: number;
  transfersOut: number;
  outOfStock: number | null;
  atRisk: number | null;
  excess: number | null;
  excessValueAtCost: number | null;
}

export const fetchOverview = () => getJson<Overview>('/overview');
export const fetchLocationHealth = () => getJson<LocationHealth[]>('/overview/locations');
