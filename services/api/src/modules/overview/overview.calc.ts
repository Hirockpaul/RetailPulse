/**
 * Pure classification of store stock positions for the Overview page (no I/O, unit-tested).
 *
 *   available = on hand − reserved          position = available + inbound
 *   OUT_OF_STOCK  available ≤ 0                                    (needs no forecast)
 *   AT_RISK       available > 0 and position < forecast demand of the next `riskWindowDays`
 *   EXCESS        position > `excessCoverDays` × average daily forecast demand
 *
 * AT_RISK and EXCESS need a forecast for that product at that store; positions without one are
 * counted as `withoutForecast` and never guessed.
 */

export interface PositionRow {
  productId: string;
  sku: string;
  productName: string;
  locationId: string;
  locationCode: string;
  available: number;
  inbound: number;
  /** Forecast units over the next `riskWindowDays` days; null without a forecast. */
  demandWindow: number | null;
  /** Average forecast units per day over the horizon; null without a forecast. */
  avgDaily: number | null;
  /** Forecast units over the next `riskWindowLongDays` days (Control Tower, V2 4a). */
  demandWindowLong?: number | null;
  /** Primary supplier unit cost (value at cost); null when the product has none. */
  unitCost?: number | null;
}

export interface PositionItem {
  productId: string;
  sku: string;
  productName: string;
  locationId: string;
  locationCode: string;
  available: number;
  inbound: number;
  /** Units forecast over the risk window (rounded to 0.1). */
  demandWindow: number;
  /** position ÷ average daily demand; null when the forecast is zero. */
  daysOfCover: number | null;
  /** EXCESS only: units above `excessCoverDays` of demand. */
  excessUnits?: number;
}

export interface PositionSummary {
  positions: number;
  withoutForecast: number;
  outOfStock: number;
  atRisk: number;
  excess: number;
  excessUnits: number;
  atRiskTop: PositionItem[];
  excessTop: PositionItem[];
}

export interface SummaryConfig {
  riskWindowDays: number;
  excessCoverDays: number;
  topN: number;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

export function summarizePositions(rows: PositionRow[], cfg: SummaryConfig): PositionSummary {
  const atRisk: PositionItem[] = [];
  const excess: PositionItem[] = [];
  let outOfStock = 0;
  let withoutForecast = 0;

  for (const r of rows) {
    if (r.available <= 0) outOfStock++;
    if (r.demandWindow === null || r.avgDaily === null) {
      withoutForecast++;
      continue;
    }
    const position = r.available + r.inbound;
    const item: PositionItem = {
      productId: r.productId,
      sku: r.sku,
      productName: r.productName,
      locationId: r.locationId,
      locationCode: r.locationCode,
      available: r.available,
      inbound: r.inbound,
      demandWindow: round1(r.demandWindow),
      daysOfCover: r.avgDaily > 0 ? round1(Math.max(position, 0) / r.avgDaily) : null,
    };
    if (r.available > 0 && position < r.demandWindow) {
      atRisk.push(item);
    } else {
      const limit = Math.ceil(cfg.excessCoverDays * r.avgDaily);
      if (position > limit) excess.push({ ...item, excessUnits: position - limit });
    }
  }

  // Soonest to run out first; most surplus first. Ties by SKU and store so the order is stable.
  const stable = (a: PositionItem, b: PositionItem) =>
    a.sku.localeCompare(b.sku) || a.locationCode.localeCompare(b.locationCode);
  atRisk.sort((a, b) => (a.daysOfCover ?? 0) - (b.daysOfCover ?? 0) || stable(a, b));
  excess.sort((a, b) => (b.excessUnits ?? 0) - (a.excessUnits ?? 0) || stable(a, b));

  return {
    positions: rows.length,
    withoutForecast,
    outOfStock,
    atRisk: atRisk.length,
    excess: excess.length,
    excessUnits: excess.reduce((n, i) => n + (i.excessUnits ?? 0), 0),
    atRiskTop: atRisk.slice(0, cfg.topN),
    excessTop: excess.slice(0, cfg.topN),
  };
}

// ---------------------------------------------------------------- Control Tower (V2 4a-1)

export type PositionState = 'OUT_OF_STOCK' | 'NO_FORECAST' | 'AT_RISK' | 'EXCESS' | 'HEALTHY';

/**
 * One state per store position, mutually exclusive, in this order: out of stock (nothing
 * available) → no forecast → at risk (position below the window's forecast demand) → excess
 * (above `excessCoverDays` of demand) → healthy. Same thresholds as `summarizePositions`.
 */
export function classifyPosition(
  r: PositionRow,
  cfg: Pick<SummaryConfig, 'excessCoverDays'>,
): { state: PositionState; excessUnits: number } {
  if (r.available <= 0) return { state: 'OUT_OF_STOCK', excessUnits: 0 };
  if (r.demandWindow === null || r.avgDaily === null)
    return { state: 'NO_FORECAST', excessUnits: 0 };
  const position = r.available + r.inbound;
  if (position < r.demandWindow) return { state: 'AT_RISK', excessUnits: 0 };
  const limit = Math.ceil(cfg.excessCoverDays * r.avgDaily);
  if (position > limit) return { state: 'EXCESS', excessUnits: position - limit };
  return { state: 'HEALTHY', excessUnits: 0 };
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
  /** Excess units × primary supplier unit cost (products without a cost count 0). */
  excessValue: number;
}

/** Per-store counts of each state, plus excess units and value at cost; sorted by store code. */
export function healthByStore(
  rows: PositionRow[],
  cfg: Pick<SummaryConfig, 'excessCoverDays'>,
): StoreHealth[] {
  const byStore = new Map<string, StoreHealth>();
  for (const r of rows) {
    const h =
      byStore.get(r.locationId) ??
      byStore
        .set(r.locationId, {
          locationId: r.locationId,
          locationCode: r.locationCode,
          outOfStock: 0,
          noForecast: 0,
          atRisk: 0,
          excess: 0,
          healthy: 0,
          excessUnits: 0,
          excessValue: 0,
        })
        .get(r.locationId)!;
    const { state, excessUnits } = classifyPosition(r, cfg);
    const key = (
      {
        OUT_OF_STOCK: 'outOfStock',
        NO_FORECAST: 'noForecast',
        AT_RISK: 'atRisk',
        EXCESS: 'excess',
        HEALTHY: 'healthy',
      } as const
    )[state];
    h[key]++;
    h.excessUnits += excessUnits;
    h.excessValue += excessUnits * (r.unitCost ?? 0);
  }
  return [...byStore.values()]
    .map((h) => ({ ...h, excessValue: Math.round(h.excessValue * 100) / 100 }))
    .sort((a, b) => a.locationCode.localeCompare(b.locationCode));
}

/** Positions with something available that will not cover the longer window's forecast. */
export function atRiskWithin(rows: PositionRow[], window: 'short' | 'long'): number {
  let n = 0;
  for (const r of rows) {
    const demand = window === 'short' ? r.demandWindow : (r.demandWindowLong ?? null);
    if (r.available > 0 && demand !== null && r.available + r.inbound < demand) n++;
  }
  return n;
}
