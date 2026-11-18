/**
 * The replenishment calculation: pure functions, no database, fully explainable.
 *
 *   L, σL            = lead time and its spread: 2 days / 0 from a distribution centre; from a
 *                      supplier, its promise + its measured average delay, and the spread of that
 *                      delay (promise and 0 while it has too few recorded deliveries)
 *   demandDuringLead = forecast units over the next L days (days beyond the forecast horizon
 *                      use the horizon's average; part of a day counts in proportion)
 *   d                = demandDuringLead / L, average forecast units per day
 *   safetyStock      = z × √(L × σe² + d² × σL²)    σe = the forecast's typical daily error;
 *                      z from the service level of the product's ABC/XYZ class at the store
 *   reorderPoint     = demandDuringLead + safetyStock
 *   orderUpTo        = forecast units over L + R days + safetyStock      (R = review period)
 *   position         = available + inbound            (available = on hand − reserved)
 *   needs stock when position < reorderPoint; quantity = orderUpTo − position,
 *   rounded UP to whole packs (and for purchase orders at least the supplier minimum).
 *
 * Source: a distribution centre with enough stock (short lead time) — otherwise the supplier.
 * Nothing here moves stock or orders anything; a manager approves the result.
 * Rules: docs/V2-PLAN.md step 2b (safety stock v2).
 */

import {
  REPLENISHMENT,
  SERVICE_LEVEL_BY_CLASS,
  type ServiceLevel,
  Z_BY_SERVICE_LEVEL,
} from './replenishment.config';

export type Action = 'TRANSFER' | 'PURCHASE_ORDER';
export type Risk = 'CRITICAL' | 'HIGH';

export interface DcStock {
  locationId: string;
  code: string;
  /** On hand − reserved − units already promised to other open transfers. */
  availableNet: number;
}

export interface SupplierTerms {
  id: string;
  name: string;
  leadTimeDays: number;
  minOrderQty: number;
  unitCost: number;
}

/** How late a supplier delivers compared with its promise, over its recorded deliveries. */
export interface SupplierDelay {
  deliveries: number;
  meanDelayDays: number;
  /** null with fewer than 2 deliveries. */
  stdDelayDays: number | null;
}

export type LeadTimeBasis = 'transfer' | 'measured' | 'promised';

export interface LeadTime {
  /** Expected lead time L in days (may be fractional when measured). */
  meanDays: number;
  /** Standard deviation σL of the lead time in days (0 when not measured). */
  stdDays: number;
  basis: LeadTimeBasis;
  /** Supplier deliveries behind the measurement (null for transfers). */
  deliveries: number | null;
}

export interface PlanInput {
  /** Forecast units for day 1..H. */
  yhat: number[];
  /** The forecast's typical daily error σe (root-mean-square backtest error). */
  sigmaError: number;
  packSize: number;
  available: number;
  inbound: number;
  supplier: SupplierTerms | null;
  /** The supplier's measured delay; null when it has no recorded deliveries. */
  supplierDelay: SupplierDelay | null;
  /** DC stock still unallocated (earlier recommendations in the same batch already took theirs). */
  dcs: DcStock[];
  serviceLevelZ: number;
  reviewPeriodDays: number;
  transferLeadTimeDays: number;
  /** Deliveries a supplier needs before its measured delay is used. */
  minSupplierDeliveries: number;
}

export interface Plan {
  action: Action;
  quantity: number;
  risk: Risk;
  /** Days the stock position lasts at the forecast rate (null if no demand is forecast). */
  daysOfCover: number | null;
  leadTimeDays: number;
  leadTimeSource: 'transfer' | 'supplier';
  leadTimeStdDays: number;
  leadTimeBasis: LeadTimeBasis;
  leadTimeDeliveries: number | null;
  demandDuringLead: number;
  demandDuringCover: number;
  avgDailyDemand: number;
  safetyStock: number;
  /** The two parts under the square root: forecast error (L·σe²) and lead time (d²·σL²). */
  safetyStockParts: { demandVariance: number; leadTimeVariance: number };
  reorderPoint: number;
  orderUpTo: number;
  position: number;
  rawQuantity: number;
  /** Set for transfers: the distribution centre chosen. */
  sourceDc: DcStock | null;
  supplier: SupplierTerms | null;
  /** Set when a DC had some stock but not enough, so a purchase order was suggested instead. */
  dcShortfall: { code: string; availableNet: number; needed: number } | null;
}

/** NO_NEED carries the numbers that show why (position at or above the reorder point). */
export type PlanResult =
  | { plan: Plan }
  | { skip: 'NO_NEED'; position: number; reorderPoint: number; leadTimeDays: number }
  | { skip: 'NO_SOURCE' };

export type ReviewReason = 'FALLBACK_FORECAST' | 'ERRATIC_DEMAND';

/**
 * Why a person should set the quantity (V2 2d-1): the forecast is only a category average, or
 * demand at this store is erratic (class Z). The fallback wins when both apply.
 */
export function reviewReason(isFallback: boolean, cls: string | null): ReviewReason | null {
  if (isFallback) return 'FALLBACK_FORECAST';
  if (cls && cls.length === 2 && cls[1] === 'Z') return 'ERRATIC_DEMAND';
  return null;
}

/**
 * Expected stockout, in forecast days (V2 2d-1): 0 = out of stock now (nothing available);
 * otherwise the first day k on which cumulative forecast demand (day 1..k) exceeds the position.
 * Beyond the forecast horizon the horizon's average is used (`beyondForecast`); null when it
 * does not happen within `maxDays` (or no demand is forecast).
 */
export function stockoutDay(
  yhat: number[],
  available: number,
  position: number,
  maxDays: number,
): { day: number | null; beyondForecast: boolean } {
  if (available <= 0) return { day: 0, beyondForecast: false };
  if (yhat.length === 0) return { day: null, beyondForecast: false };
  const average = yhat.reduce((a, b) => a + b, 0) / yhat.length;
  let cumulative = 0;
  for (let k = 1; k <= maxDays; k++) {
    cumulative += k <= yhat.length ? yhat[k - 1] : average;
    if (cumulative > position + 1e-9) return { day: k, beyondForecast: k > yhat.length };
  }
  return { day: null, beyondForecast: false };
}

/** A forecast day as a date: day k after the last day of data ('YYYY-MM-DD'). */
export function dayToDate(historyEnd: string, k: number): string {
  const d = new Date(`${historyEnd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + k);
  return d.toISOString().slice(0, 10);
}

export const roundUpToMultiple = (quantity: number, multiple: number): number =>
  Math.ceil(quantity / Math.max(multiple, 1)) * Math.max(multiple, 1);

/**
 * Forecast demand over `days` days; beyond the forecast horizon, assume the horizon's average.
 * A fractional day counts in proportion (2.5 days = days 1 and 2 + half of day 3).
 */
export function demandOver(yhat: number[], days: number): number {
  if (yhat.length === 0 || days <= 0) return 0;
  const average = yhat.reduce((a, b) => a + b, 0) / yhat.length;
  const day = (i: number) => (i < yhat.length ? yhat[i] : average);
  const whole = Math.floor(days);
  let total = 0;
  for (let i = 0; i < whole; i++) total += day(i);
  return total + (days - whole) * day(whole);
}

/** Service level and z for a product's ABC/XYZ class at a store (NEW / unknown: the default). */
export function serviceLevelFor(cls: string | null): { serviceLevel: ServiceLevel; z: number } {
  const serviceLevel =
    (cls ? SERVICE_LEVEL_BY_CLASS[cls] : undefined) ??
    (REPLENISHMENT.defaultServiceLevel as ServiceLevel);
  return { serviceLevel, z: Z_BY_SERVICE_LEVEL[serviceLevel] };
}

/**
 * Supplier lead time: the promise plus the measured average delay, with the delay's spread — or
 * the plain promise with no spread while the supplier has fewer than `minDeliveries` deliveries.
 */
export function supplierLeadTime(
  promisedDays: number,
  delay: SupplierDelay | null,
  minDeliveries: number,
): LeadTime {
  if (delay && delay.deliveries >= minDeliveries) {
    return {
      meanDays: Math.max(0, promisedDays + delay.meanDelayDays),
      stdDays: delay.stdDelayDays ?? 0,
      basis: 'measured',
      deliveries: delay.deliveries,
    };
  }
  return {
    meanDays: promisedDays,
    stdDays: 0,
    basis: 'promised',
    deliveries: delay?.deliveries ?? 0,
  };
}

/** SS = z × √(L·σe² + d²·σL²), with the two variance parts for the explanation. */
export function safetyStock(
  z: number,
  sigmaError: number,
  avgDailyDemand: number,
  lead: Pick<LeadTime, 'meanDays' | 'stdDays'>,
): { value: number; demandVariance: number; leadTimeVariance: number } {
  const demandVariance = lead.meanDays * sigmaError ** 2;
  const leadTimeVariance = avgDailyDemand ** 2 * lead.stdDays ** 2;
  return {
    value: z * Math.sqrt(demandVariance + leadTimeVariance),
    demandVariance,
    leadTimeVariance,
  };
}

interface Evaluation {
  lead: LeadTime;
  dLead: number;
  dCover: number;
  avgDailyDemand: number;
  safetyStock: number;
  safetyStockParts: Plan['safetyStockParts'];
  reorderPoint: number;
  orderUpTo: number;
}

function evaluate(input: PlanInput, lead: LeadTime): Evaluation {
  const L = lead.meanDays;
  const dLead = demandOver(input.yhat, L);
  const dCover = demandOver(input.yhat, L + input.reviewPeriodDays);
  // Average per day over the lead time (over day 1 if the lead time is under a day).
  const avgDailyDemand = L >= 1 ? dLead / L : demandOver(input.yhat, 1);
  const ss = safetyStock(input.serviceLevelZ, input.sigmaError, avgDailyDemand, lead);
  return {
    lead,
    dLead,
    dCover,
    avgDailyDemand,
    safetyStock: ss.value,
    safetyStockParts: { demandVariance: ss.demandVariance, leadTimeVariance: ss.leadTimeVariance },
    reorderPoint: dLead + ss.value,
    orderUpTo: dCover + ss.value,
  };
}

function buildPlan(
  input: PlanInput,
  action: Action,
  e: Evaluation,
  extra: Pick<Plan, 'sourceDc' | 'supplier' | 'dcShortfall'>,
): Plan {
  const position = input.available + input.inbound;
  const rawQuantity = Math.max(0, e.orderUpTo - position);
  let quantity = roundUpToMultiple(Math.ceil(rawQuantity), input.packSize);
  if (action === 'PURCHASE_ORDER' && extra.supplier) {
    quantity = Math.max(quantity, roundUpToMultiple(extra.supplier.minOrderQty, input.packSize));
  }
  const leadDays = e.lead.meanDays;
  const daysOfCover = e.avgDailyDemand > 0 ? position / e.avgDailyDemand : null;
  const critical = input.available <= 0 || (daysOfCover !== null && daysOfCover < leadDays);
  return {
    action,
    quantity,
    risk: critical ? 'CRITICAL' : 'HIGH',
    daysOfCover,
    leadTimeDays: leadDays,
    leadTimeSource: action === 'TRANSFER' ? 'transfer' : 'supplier',
    leadTimeStdDays: e.lead.stdDays,
    leadTimeBasis: e.lead.basis,
    leadTimeDeliveries: e.lead.deliveries,
    demandDuringLead: e.dLead,
    demandDuringCover: e.dCover,
    avgDailyDemand: e.avgDailyDemand,
    safetyStock: e.safetyStock,
    safetyStockParts: e.safetyStockParts,
    reorderPoint: e.reorderPoint,
    orderUpTo: e.orderUpTo,
    position,
    rawQuantity,
    ...extra,
  };
}

const noNeed = (position: number, e: Evaluation): PlanResult => ({
  skip: 'NO_NEED',
  position,
  reorderPoint: e.reorderPoint,
  leadTimeDays: e.lead.meanDays,
});

/** Decide whether a product at a store needs replenishing, and how. */
export function plan(input: PlanInput): PlanResult {
  const position = input.available + input.inbound;
  let dcShortfall: Plan['dcShortfall'] = null;

  const dcs = input.dcs
    .filter((d) => d.availableNet >= 1)
    .sort((a, b) => b.availableNet - a.availableNet);
  if (dcs.length > 0) {
    const e = evaluate(input, {
      meanDays: input.transferLeadTimeDays,
      stdDays: 0,
      basis: 'transfer',
      deliveries: null,
    });
    if (position >= e.reorderPoint) return noNeed(position, e);
    const candidate = buildPlan(input, 'TRANSFER', e, {
      sourceDc: dcs[0],
      supplier: null,
      dcShortfall: null,
    });
    if (dcs[0].availableNet >= candidate.quantity) return { plan: candidate };
    dcShortfall = {
      code: dcs[0].code,
      availableNet: dcs[0].availableNet,
      needed: candidate.quantity,
    };
  }

  if (!input.supplier) return { skip: 'NO_SOURCE' };
  const e = evaluate(
    input,
    supplierLeadTime(input.supplier.leadTimeDays, input.supplierDelay, input.minSupplierDeliveries),
  );
  if (position >= e.reorderPoint) return noNeed(position, e);
  return {
    plan: buildPlan(input, 'PURCHASE_ORDER', e, {
      sourceDc: null,
      supplier: input.supplier,
      dcShortfall,
    }),
  };
}

const n1 = (x: number) => (Math.round(x * 10) / 10).toString();
const n2 = (x: number) => (Math.round(x * 100) / 100).toString();
const pct = (x: number) => `${Math.round(x * 100)} %`;

export interface ExplainContext {
  sku: string;
  locationCode: string;
  model: string;
  isFallback: boolean;
  sigmaError: number;
  /** The product's ABC/XYZ class at this store (null = not classified yet). */
  cls: string | null;
  serviceLevel: number;
  serviceLevelZ: number;
  reviewPeriodDays: number;
  packSize: number;
  available: number;
  inbound: number;
  /** Expected stockout (V2 2d-1); `date` null = not within the stockout horizon. */
  stockout?: { day: number | null; date: string | null; beyondForecast: boolean };
  review?: ReviewReason | null;
}

const REVIEW_TEXT: Record<ReviewReason, string> = {
  FALLBACK_FORECAST:
    'the forecast is only a category average because this product has little sales history here',
  ERRATIC_DEMAND: `demand for this product at this store is erratic (class Z), where the safety-stock formula is least reliable`,
};

function stockoutText(s: NonNullable<ExplainContext['stockout']>): string {
  if (s.day === 0) return 'Out of stock now.';
  if (s.day === null || s.date === null)
    return 'No stockout expected within 90 days at the forecast rate.';
  return (
    `Expected stockout on ${s.date} (forecast day ${s.day})` +
    (s.beyondForecast ? ', an estimate beyond the forecast horizon at its average rate.' : '.')
  );
}

function leadTimeText(p: Plan): string {
  const L = n1(p.leadTimeDays);
  if (p.leadTimeBasis === 'transfer') {
    return `Lead time ${L} days from a distribution centre (no measured transfer history, so no spread is assumed).`;
  }
  const promised = p.supplier?.leadTimeDays ?? p.leadTimeDays;
  if (p.leadTimeBasis === 'measured') {
    const delay = p.leadTimeDays - promised;
    return (
      `Lead time ${L} days = ${promised} promised + ${n1(delay)} average delay over ${p.leadTimeDeliveries} recorded deliveries;` +
      ` the delay varies by ${n2(p.leadTimeStdDays)} days (standard deviation).`
    );
  }
  return `Lead time ${L} days as promised (only ${p.leadTimeDeliveries ?? 0} recorded deliveries, too few to measure delays, so no spread is assumed).`;
}

/** The calculation in words and numbers, so a manager can check it by hand. */
export function explain(p: Plan, c: ExplainContext): string {
  const L = n1(p.leadTimeDays);
  const lines = [
    `Forecast demand for ${c.sku} at ${c.locationCode} over the next ${L} days: ${n1(p.demandDuringLead)} units` +
      ` (model ${c.model}${c.isFallback ? ', category-average fallback because this product has little sales history' : ''}).`,
    leadTimeText(p),
    `Service level ${pct(c.serviceLevel)} (${c.cls && c.cls !== 'NEW' ? `class ${c.cls} at ${c.locationCode}` : 'not classified yet: default'}) → z = ${c.serviceLevelZ}.`,
    `Safety stock = z × √(L × σe² + d² × σL²) = ${c.serviceLevelZ} × √(${L} × ${n2(c.sigmaError)}² + ${n2(p.avgDailyDemand)}² × ${n2(p.leadTimeStdDays)}²) = ${n1(p.safetyStock)}` +
      ` (σe = the forecast's typical daily error, d = forecast units per day, σL = lead-time spread).`,
    `Reorder point = ${n1(p.demandDuringLead)} + ${n1(p.safetyStock)} = ${n1(p.reorderPoint)}.`,
    `Stock position = ${c.available} available + ${c.inbound} inbound = ${p.position}, which is below the reorder point.`,
    `Order-up-to level covers ${L} + ${c.reviewPeriodDays} days: ${n1(p.demandDuringCover)} + ${n1(p.safetyStock)} = ${n1(p.orderUpTo)}.`,
    `Need ${n1(p.rawQuantity)} → rounded up to packs of ${c.packSize}` +
      (p.action === 'PURCHASE_ORDER' && p.supplier
        ? ` (supplier minimum order ${p.supplier.minOrderQty})`
        : '') +
      ` = ${p.quantity} units.`,
  ];
  if (p.action === 'TRANSFER' && p.sourceDc) {
    lines.push(
      `Source: transfer from ${p.sourceDc.code}, which has ${p.sourceDc.availableNet} units not already promised.`,
    );
  } else if (p.supplier) {
    lines.push(
      p.dcShortfall
        ? `Source: no distribution centre can cover it (${p.dcShortfall.code} has ${p.dcShortfall.availableNet}, ${p.dcShortfall.needed} needed), so order from ${p.supplier.name}.`
        : `Source: no distribution centre has stock, so order from ${p.supplier.name}.`,
    );
  }
  lines.push(
    p.daysOfCover === null
      ? `Risk ${p.risk}.`
      : `Days of cover: ${n1(p.daysOfCover)} (${p.daysOfCover < p.leadTimeDays ? 'less than' : 'at least'} the ${L}-day lead time) → risk ${p.risk}.`,
  );
  if (c.stockout) lines.push(stockoutText(c.stockout));
  if (c.review) {
    lines.push(
      `Manual review: ${REVIEW_TEXT[c.review]}, so a manager sets the quantity when approving (${p.quantity} is only a starting point).`,
    );
  }
  return lines.join(' ');
}
