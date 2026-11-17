/**
 * The replenishment calculation: pure functions, no database, fully explainable.
 *
 *   demandDuringLead = forecast units over the next L days (days beyond the forecast horizon
 *                      use the horizon's average)
 *   safetyStock      = z × σ_daily × √L
 *   reorderPoint     = demandDuringLead + safetyStock
 *   orderUpTo        = forecast units over L + R days + safetyStock      (R = review period)
 *   position         = available + inbound            (available = on hand − reserved)
 *   needs stock when position < reorderPoint; quantity = orderUpTo − position,
 *   rounded UP to whole packs (and for purchase orders at least the supplier minimum).
 *
 * Source: a distribution centre with enough stock (short lead time) — otherwise the supplier.
 * Nothing here moves stock or orders anything; a manager approves the result.
 */

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

export interface PlanInput {
  /** Forecast units for day 1..H. */
  yhat: number[];
  /** Standard deviation of daily demand. */
  sigmaDaily: number;
  packSize: number;
  available: number;
  inbound: number;
  supplier: SupplierTerms | null;
  /** DC stock still unallocated (earlier recommendations in the same batch already took theirs). */
  dcs: DcStock[];
  serviceLevelZ: number;
  reviewPeriodDays: number;
  transferLeadTimeDays: number;
}

export interface Plan {
  action: Action;
  quantity: number;
  risk: Risk;
  /** Days the stock position lasts at the forecast rate (null if no demand is forecast). */
  daysOfCover: number | null;
  leadTimeDays: number;
  leadTimeSource: 'transfer' | 'supplier';
  demandDuringLead: number;
  demandDuringCover: number;
  avgDailyDemand: number;
  safetyStock: number;
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

export type PlanResult = { plan: Plan } | { skip: 'NO_NEED' | 'NO_SOURCE' };

export const roundUpToMultiple = (quantity: number, multiple: number): number =>
  Math.ceil(quantity / Math.max(multiple, 1)) * Math.max(multiple, 1);

/** Forecast demand over `days` days; beyond the forecast horizon, assume the horizon's average. */
export function demandOver(yhat: number[], days: number): number {
  const n = Math.max(0, Math.ceil(days));
  if (yhat.length === 0) return 0;
  const used = yhat.slice(0, n).reduce((a, b) => a + b, 0);
  const average = yhat.reduce((a, b) => a + b, 0) / yhat.length;
  return used + Math.max(0, n - yhat.length) * average;
}

interface Evaluation {
  dLead: number;
  dCover: number;
  safetyStock: number;
  reorderPoint: number;
  orderUpTo: number;
}

function evaluate(input: PlanInput, leadDays: number): Evaluation {
  const dLead = demandOver(input.yhat, leadDays);
  const dCover = demandOver(input.yhat, leadDays + input.reviewPeriodDays);
  const safetyStock = input.serviceLevelZ * input.sigmaDaily * Math.sqrt(leadDays);
  return {
    dLead,
    dCover,
    safetyStock,
    reorderPoint: dLead + safetyStock,
    orderUpTo: dCover + safetyStock,
  };
}

function buildPlan(
  input: PlanInput,
  action: Action,
  leadDays: number,
  e: Evaluation,
  extra: Pick<Plan, 'sourceDc' | 'supplier' | 'dcShortfall'>,
): Plan {
  const position = input.available + input.inbound;
  const rawQuantity = Math.max(0, e.orderUpTo - position);
  let quantity = roundUpToMultiple(Math.ceil(rawQuantity), input.packSize);
  if (action === 'PURCHASE_ORDER' && extra.supplier) {
    quantity = Math.max(quantity, roundUpToMultiple(extra.supplier.minOrderQty, input.packSize));
  }
  const avgDailyDemand = leadDays > 0 ? e.dLead / leadDays : 0;
  const daysOfCover = avgDailyDemand > 0 ? position / avgDailyDemand : null;
  const critical = input.available <= 0 || (daysOfCover !== null && daysOfCover < leadDays);
  return {
    action,
    quantity,
    risk: critical ? 'CRITICAL' : 'HIGH',
    daysOfCover,
    leadTimeDays: leadDays,
    leadTimeSource: action === 'TRANSFER' ? 'transfer' : 'supplier',
    demandDuringLead: e.dLead,
    demandDuringCover: e.dCover,
    avgDailyDemand,
    safetyStock: e.safetyStock,
    reorderPoint: e.reorderPoint,
    orderUpTo: e.orderUpTo,
    position,
    rawQuantity,
    ...extra,
  };
}

/** Decide whether a product at a store needs replenishing, and how. */
export function plan(input: PlanInput): PlanResult {
  const position = input.available + input.inbound;
  let dcShortfall: Plan['dcShortfall'] = null;

  const dcs = input.dcs
    .filter((d) => d.availableNet >= 1)
    .sort((a, b) => b.availableNet - a.availableNet);
  if (dcs.length > 0) {
    const e = evaluate(input, input.transferLeadTimeDays);
    if (position >= e.reorderPoint) return { skip: 'NO_NEED' };
    const candidate = buildPlan(input, 'TRANSFER', input.transferLeadTimeDays, e, {
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
  const e = evaluate(input, input.supplier.leadTimeDays);
  if (position >= e.reorderPoint) return { skip: 'NO_NEED' };
  return {
    plan: buildPlan(input, 'PURCHASE_ORDER', input.supplier.leadTimeDays, e, {
      sourceDc: null,
      supplier: input.supplier,
      dcShortfall,
    }),
  };
}

const n1 = (x: number) => (Math.round(x * 10) / 10).toString();

export interface ExplainContext {
  sku: string;
  locationCode: string;
  model: string;
  isFallback: boolean;
  sigmaDaily: number;
  serviceLevelZ: number;
  reviewPeriodDays: number;
  packSize: number;
  available: number;
  inbound: number;
}

/** The calculation in words and numbers, so a manager can check it by hand. */
export function explain(p: Plan, c: ExplainContext): string {
  const L = p.leadTimeDays;
  const lines = [
    `Forecast demand for ${c.sku} at ${c.locationCode} over the next ${L} days: ${n1(p.demandDuringLead)} units` +
      ` (model ${c.model}${c.isFallback ? ', category-average fallback because this product has little sales history' : ''}).`,
    `Safety stock = ${c.serviceLevelZ} × ${n1(c.sigmaDaily)} (daily demand spread) × √${L} = ${n1(p.safetyStock)}.`,
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
        ? `Source: no distribution centre can cover it (${p.dcShortfall.code} has ${p.dcShortfall.availableNet}, ${p.dcShortfall.needed} needed), so order from ${p.supplier.name}, lead time ${L} days.`
        : `Source: no distribution centre has stock, so order from ${p.supplier.name}, lead time ${L} days.`,
    );
  }
  lines.push(
    p.daysOfCover === null
      ? `Risk ${p.risk}.`
      : `Days of cover: ${n1(p.daysOfCover)} (${p.daysOfCover < L ? 'less than' : 'at least'} the ${L}-day lead time) → risk ${p.risk}.`,
  );
  return lines.join(' ');
}
