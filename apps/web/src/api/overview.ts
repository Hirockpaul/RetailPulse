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
    byAction: { TRANSFER: number; PURCHASE_ORDER: number };
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
}

export const fetchOverview = () => getJson<Overview>('/overview');
