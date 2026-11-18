import { OVERVIEW } from '../overview/overview.config';
import {
  chooseDc,
  type DcStock,
  demandOver,
  excessAt,
  explain,
  explainExcess,
  dayToDate,
  plan,
  type PlanInput,
  reviewReason,
  roundUpToMultiple,
  safetyStock,
  serviceLevelFor,
  stockoutDay,
  supplierLeadTime,
  type SupplierDelay,
  type SupplierTerms,
} from './replenishment.calc';
import { REPLENISHMENT } from './replenishment.config';

const supplier: SupplierTerms = {
  id: 's1',
  name: 'Harbor Provisions (synthetic)',
  leadTimeDays: 7,
  minOrderQty: 24,
  unitCost: 1.5,
};
const dc = (availableNet: number, code = 'DC-NORTH'): DcStock => ({
  locationId: code,
  code,
  availableNet,
});

/**
 * 10 units/day forecast for 14 days, σe = 3, packs of 12, no measured supplier delay (σL = 0) —
 * easy numbers to check by hand. With σL = 0, SS = z × σe × √L.
 */
const base = (over: Partial<PlanInput> = {}): PlanInput => ({
  yhat: Array(14).fill(10),
  sigmaError: 3,
  packSize: 12,
  available: 20,
  inbound: 0,
  supplier,
  supplierDelay: null,
  dcs: [],
  serviceLevelZ: 1.645,
  reviewPeriodDays: 7,
  transferLeadTimeDays: 2,
  minSupplierDeliveries: 20,
  ...over,
});

const planned = (input: PlanInput) => {
  const r = plan(input);
  if ('skip' in r) throw new Error(`expected a plan, got skip ${r.skip}`);
  return r.plan;
};

describe('roundUpToMultiple', () => {
  it.each([
    [1, 12, 12],
    [12, 12, 12],
    [13, 12, 24],
    [133, 12, 144],
    [5, 1, 5],
    [5, 0, 5], // a pack size of 0 is treated as 1
  ])('%i up to a multiple of %i = %i', (q, m, expected) => {
    expect(roundUpToMultiple(q, m)).toBe(expected);
  });
});

describe('demandOver', () => {
  it('sums the forecast for the first N days', () => {
    expect(demandOver([1, 2, 3, 4], 2)).toBe(3);
    expect(demandOver([1, 2, 3, 4], 4)).toBe(10);
  });

  it('beyond the horizon, assumes the horizon average', () => {
    expect(demandOver([2, 4], 4)).toBe(2 + 4 + 2 * 3); // 6 + two more days at the average of 3
  });

  it('is 0 for no forecast or no days', () => {
    expect(demandOver([], 5)).toBe(0);
    expect(demandOver([5, 5], 0)).toBe(0);
  });

  it('counts part of a day in proportion (measured lead times are fractional)', () => {
    expect(demandOver([10, 20, 30], 1.5)).toBeCloseTo(10 + 0.5 * 20, 9);
    expect(demandOver([2, 4], 2.5)).toBeCloseTo(6 + 0.5 * 3, 9); // half a day at the average
  });
});

describe('plan — purchase order (no distribution-centre stock)', () => {
  it('follows the documented formulas (checked by hand)', () => {
    // L = 7 days: demand 70; safety 1.645 × 3 × √7 = 13.057; reorder point 83.057
    // order-up-to covers 14 days: 140 + 13.057 = 153.057; position 20 → need 133.057
    // → 134 → rounded up to whole packs of 12 = 144 (≥ minimum 24)
    const p = planned(base());
    expect(p.action).toBe('PURCHASE_ORDER');
    expect(p.leadTimeDays).toBe(7);
    expect(p.leadTimeSource).toBe('supplier');
    expect(p.demandDuringLead).toBe(70);
    expect(p.safetyStock).toBeCloseTo(13.057, 3);
    expect(p.reorderPoint).toBeCloseTo(83.057, 3);
    expect(p.orderUpTo).toBeCloseTo(153.057, 3);
    expect(p.position).toBe(20);
    expect(p.rawQuantity).toBeCloseTo(133.057, 3);
    expect(p.quantity).toBe(144);
    expect(p.supplier?.name).toContain('Harbor');
    expect(p.source).toBeNull();
  });

  it('counts inbound stock in the position', () => {
    const p = planned(base({ inbound: 60 }));
    expect(p.position).toBe(80); // 20 + 60, still below the 83.06 reorder point
    expect(p.quantity).toBe(Math.ceil((153.057 - 80) / 12) * 12); // 74 → 84
    expect(p.quantity).toBe(84);
  });

  it('does nothing when the position is at or above the reorder point', () => {
    expect(plan(base({ available: 84 }))).toMatchObject({ skip: 'NO_NEED', position: 84 });
    expect(plan(base({ available: 30, inbound: 60 }))).toMatchObject({ skip: 'NO_NEED' });
  });

  it('raises a small need to the supplier minimum, in whole packs', () => {
    // Need is only ~7 units, but the supplier's minimum is 30 → 36 (3 packs of 12)
    const p = planned(
      base({
        available: 78,
        supplier: { ...supplier, minOrderQty: 30 },
      }),
    );
    expect(p.rawQuantity).toBeCloseTo(75.057, 3);
    expect(p.quantity).toBe(84); // 76 → 84, already above the minimum
    const tiny = planned(
      base({
        yhat: Array(14).fill(1),
        sigmaError: 0,
        available: 3,
        supplier: { ...supplier, minOrderQty: 30 },
      }),
    );
    expect(tiny.rawQuantity).toBe(11); // 14 − 3
    expect(tiny.quantity).toBe(36); // 12 would be below the minimum of 30 → 36
  });

  it('suggests nothing when there is no demand', () => {
    expect(plan(base({ yhat: Array(14).fill(0), sigmaError: 0, available: 0 }))).toMatchObject({
      skip: 'NO_NEED',
      reorderPoint: 0,
    });
  });

  it('cannot suggest anything without a source: no supplier and no distribution-centre stock', () => {
    expect(plan(base({ supplier: null }))).toEqual({ skip: 'NO_SOURCE' });
  });
});

describe('plan — transfer from a distribution centre', () => {
  it('uses the short transfer lead time and a DC that can cover it (checked by hand)', () => {
    // L = 2: demand 20; safety 1.645 × 3 × √2 = 6.979; reorder point 26.979
    // covers 9 days: 90 + 6.979 = 96.979; position 20 → need 76.979 → 77 → 84
    const p = planned(base({ dcs: [dc(500)] }));
    expect(p.action).toBe('TRANSFER');
    expect(p.leadTimeDays).toBe(2);
    expect(p.leadTimeSource).toBe('transfer');
    expect(p.safetyStock).toBeCloseTo(6.979, 3);
    expect(p.reorderPoint).toBeCloseTo(26.979, 3);
    expect(p.orderUpTo).toBeCloseTo(96.979, 3);
    expect(p.quantity).toBe(84);
    expect(p.source?.code).toBe('DC-NORTH');
    expect(p.supplier).toBeNull();
    expect(p.dcShortfall).toBeNull();
  });

  it('picks the DC with the most unallocated stock', () => {
    const p = planned(
      base({ dcs: [dc(100, 'DC-SOUTH'), dc(900, 'DC-NORTH'), dc(300, 'DC-EAST')] }),
    );
    expect(p.source?.code).toBe('DC-NORTH');
  });

  it('does not recommend when stock already covers the short lead time', () => {
    // reorder point with the 2-day lead time is 26.979, so 27 is enough
    const ok = plan(base({ dcs: [dc(500)], available: 27 }));
    expect(ok).toMatchObject({ skip: 'NO_NEED', position: 27, leadTimeDays: 2 });
    expect('reorderPoint' in ok && ok.reorderPoint).toBeCloseTo(26.979, 3);
    expect('plan' in plan(base({ dcs: [dc(500)], available: 26 }))).toBe(true);
  });

  it('falls back to a purchase order when no DC can cover the quantity, and says why', () => {
    const p = planned(base({ dcs: [dc(40)] }));
    expect(p.action).toBe('PURCHASE_ORDER');
    expect(p.dcShortfall).toEqual({ code: 'DC-NORTH', availableNet: 40, needed: 84 });
    expect(p.leadTimeDays).toBe(7); // supplier lead time applies again
  });

  it('ignores DCs with no unallocated stock', () => {
    const p = planned(base({ dcs: [dc(0), dc(-5, 'DC-SOUTH')] }));
    expect(p.action).toBe('PURCHASE_ORDER');
    expect(p.dcShortfall).toBeNull();
  });

  it('transfers need no supplier at all', () => {
    expect(planned(base({ dcs: [dc(500)], supplier: null })).action).toBe('TRANSFER');
  });

  it('a partial DC is not enough and without a supplier there is no recommendation', () => {
    expect(plan(base({ dcs: [dc(40)], supplier: null }))).toEqual({ skip: 'NO_SOURCE' });
  });
});

describe('plan — stock-out risk', () => {
  it('CRITICAL when nothing is available', () => {
    const p = planned(base({ available: 0, inbound: 10, dcs: [dc(500)] }));
    expect(p.risk).toBe('CRITICAL');
  });

  it('plenty of inbound stock means no recommendation, even with nothing on the shelf', () => {
    expect(plan(base({ available: 0, inbound: 100, dcs: [dc(500)] }))).toMatchObject({
      skip: 'NO_NEED',
    });
  });

  it('CRITICAL when the position will not last the lead time; HIGH when it just does', () => {
    // 10 units/day, 2-day transfer lead time: 19 units last 1.9 days (<2), 20 last exactly 2
    expect(planned(base({ available: 19, dcs: [dc(500)] })).risk).toBe('CRITICAL');
    const ok = planned(base({ available: 20, dcs: [dc(500)] }));
    expect(ok.risk).toBe('HIGH');
    expect(ok.daysOfCover).toBe(2);
  });

  it('reports days of cover from the position (available + inbound)', () => {
    const p = planned(base({ available: 10, inbound: 10, dcs: [dc(500)] }));
    expect(p.daysOfCover).toBe(2);
  });
});

describe('explain', () => {
  const ctx = {
    sku: 'RP-00042',
    locationCode: 'STR-01',
    model: 'hgb_direct',
    isFallback: false,
    sigmaError: 3,
    cls: 'BY',
    serviceLevel: 0.95,
    serviceLevelZ: 1.645,
    reviewPeriodDays: 7,
    packSize: 12,
    available: 20,
    inbound: 0,
  };

  it('shows every step of a transfer with the numbers', () => {
    const text = explain(planned(base({ dcs: [dc(500)] })), ctx);
    expect(text).toContain('RP-00042 at STR-01 over the next 2 days: 20 units');
    expect(text).toContain(
      'Lead time 2 days from a distribution centre (no measured transfer history',
    );
    expect(text).toContain('Service level 95 % (class BY at STR-01) → z = 1.645');
    expect(text).toContain('= 1.645 × √(2 × 3² + 10² × 0²) = 7');
    expect(text).toContain('Reorder point = 20 + 7 = 27');
    expect(text).toContain('20 available + 0 inbound = 20');
    expect(text).toContain('rounded up to packs of 12 = 84 units');
    expect(text).toContain('transfer from DC-NORTH');
    expect(text).toContain('risk HIGH');
  });

  it('explains a purchase order, the minimum, and the distribution-centre shortfall', () => {
    const text = explain(planned(base({ dcs: [dc(40)] })), ctx);
    expect(text).toContain('supplier minimum order 24');
    expect(text).toContain('DC-NORTH has 40, 84 needed');
    expect(text).toContain('order from Harbor Provisions (synthetic).');
    expect(text).toContain('Lead time 7 days as promised (only 0 recorded deliveries');
    expect(text).toContain('= 144 units');
  });

  it('says when the forecast is only a category-average fallback', () => {
    const text = explain(planned(base()), { ...ctx, isFallback: true, model: 'category_average' });
    expect(text).toContain(
      'category-average fallback because this product has little sales history',
    );
  });
});

describe('safety stock v2 — SS = z × √(L·σe² + d²·σL²)', () => {
  it('combines forecast error and lead-time spread (checked by hand)', () => {
    // L = 9, σe = 2, d = 10, σL = 1.5: 9 × 4 = 36; 100 × 2.25 = 225; √261 = 16.1555; × 1.6449
    const ss = safetyStock(1.6449, 2, 10, { meanDays: 9, stdDays: 1.5 });
    expect(ss.demandVariance).toBe(36);
    expect(ss.leadTimeVariance).toBe(225);
    expect(ss.value).toBeCloseTo(1.6449 * Math.sqrt(261), 9);
    expect(ss.value).toBeCloseTo(26.574, 3);
  });

  it('is z × σe × √L when the lead time is exact, and z × d × σL when the forecast is', () => {
    expect(safetyStock(2, 3, 10, { meanDays: 4, stdDays: 0 }).value).toBeCloseTo(12, 9); // 2×3×2
    expect(safetyStock(2, 0, 10, { meanDays: 4, stdDays: 1.5 }).value).toBeCloseTo(30, 9); // 2×10×1.5
    expect(safetyStock(2, 0, 10, { meanDays: 4, stdDays: 0 }).value).toBe(0);
  });
});

describe('serviceLevelFor — by ABC/XYZ class at the store', () => {
  it.each([
    ['AX', 0.99, 2.3263],
    ['AY', 0.99, 2.3263],
    ['AZ', 0.97, 1.8808],
    ['BX', 0.97, 1.8808],
    ['BY', 0.97, 1.8808],
    ['BZ', 0.95, 1.6449],
    ['CX', 0.95, 1.6449],
    ['CY', 0.95, 1.6449],
    ['CZ', 0.9, 1.2816],
    ['NEW', 0.95, 1.6449],
    [null, 0.95, 1.6449],
  ])('%s → %f (z %f)', (cls, level, z) => {
    expect(serviceLevelFor(cls)).toEqual({ serviceLevel: level, z });
  });
});

describe('supplierLeadTime', () => {
  const delay = (deliveries: number, mean = 1.75, std: number | null = 1.6): SupplierDelay => ({
    deliveries,
    meanDelayDays: mean,
    stdDelayDays: std,
  });

  it('promise + measured average delay, with the delay spread, from 20 deliveries', () => {
    expect(supplierLeadTime(10, delay(20), 20)).toEqual({
      meanDays: 11.75,
      stdDays: 1.6,
      basis: 'measured',
      deliveries: 20,
    });
  });

  it('the plain promise with no spread below 20 deliveries or with no history', () => {
    expect(supplierLeadTime(10, delay(19), 20)).toEqual({
      meanDays: 10,
      stdDays: 0,
      basis: 'promised',
      deliveries: 19,
    });
    expect(supplierLeadTime(10, null, 20)).toMatchObject({ basis: 'promised', deliveries: 0 });
  });

  it('an early supplier shortens the lead time, never below 0', () => {
    expect(supplierLeadTime(3, delay(50, -0.5, 0.5), 20).meanDays).toBe(2.5);
    expect(supplierLeadTime(1, delay(50, -2, 0.5), 20).meanDays).toBe(0);
  });
});

describe('plan — purchase order with a measured supplier delay', () => {
  it('uses L = promise + delay for demand, safety stock and risk (checked by hand)', () => {
    // promised 7 + delay 1.5 → L = 8.5; demand over 8.5 days = 85; d = 10
    // SS = 2.3263 × √(8.5 × 3² + 10² × 2²) = 2.3263 × √476.5 = 50.781
    // reorder point 135.781; order-up-to covers 15.5 days = 155 + 50.781 = 205.781
    // position 20 → need 185.781 → 186 → packs of 12 = 192
    const p = planned(
      base({
        supplierDelay: { deliveries: 120, meanDelayDays: 1.5, stdDelayDays: 2 },
        serviceLevelZ: 2.3263,
      }),
    );
    expect(p.leadTimeDays).toBe(8.5);
    expect(p.leadTimeBasis).toBe('measured');
    expect(p.leadTimeStdDays).toBe(2);
    expect(p.demandDuringLead).toBeCloseTo(85, 9);
    expect(p.avgDailyDemand).toBeCloseTo(10, 9);
    expect(p.safetyStockParts).toEqual({ demandVariance: 76.5, leadTimeVariance: 400 });
    expect(p.safetyStock).toBeCloseTo(50.781, 3);
    expect(p.reorderPoint).toBeCloseTo(135.781, 3);
    expect(p.orderUpTo).toBeCloseTo(205.781, 3);
    expect(p.quantity).toBe(192);
    expect(p.supplier?.leadTimeDays).toBe(7); // the order's expected date stays the promise
  });

  it('a transfer ignores the supplier delay (2 days, no spread)', () => {
    const p = planned(
      base({
        dcs: [dc(500)],
        supplierDelay: { deliveries: 120, meanDelayDays: 3, stdDelayDays: 2 },
      }),
    );
    expect(p.leadTimeDays).toBe(2);
    expect(p.leadTimeBasis).toBe('transfer');
    expect(p.safetyStock).toBeCloseTo(6.979, 3);
  });

  it('explains the measured lead time', () => {
    const p = planned(
      base({ supplierDelay: { deliveries: 120, meanDelayDays: 1.5, stdDelayDays: 2 } }),
    );
    const text = explain(p, {
      sku: 'RP-00042',
      locationCode: 'STR-01',
      model: 'hgb_direct',
      isFallback: false,
      sigmaError: 3,
      cls: null,
      serviceLevel: 0.95,
      serviceLevelZ: 1.6449,
      reviewPeriodDays: 7,
      packSize: 12,
      available: 20,
      inbound: 0,
    });
    expect(text).toContain(
      'Lead time 8.5 days = 7 promised + 1.5 average delay over 120 recorded deliveries',
    );
    expect(text).toContain('the delay varies by 2 days');
    expect(text).toContain('Service level 95 % (not classified yet: default)');
    expect(text).toContain('√(8.5 × 3² + 10² × 2²)');
  });
});

describe('safety stock v2 — simulation under its own assumptions', () => {
  // Pre-registered check (docs/V2-PLAN.md step 2b): with normal daily errors and a normal lead
  // time, d·L + SS must cover the lead-time demand in the target share of cycles, ±1 point.
  // This checks the implementation of the formula, not whether real demand behaves like this.
  const rng = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0; // LCG, deterministic
    return (seed + 0.5) / 2 ** 32;
  };
  const normal = (u: () => number) => () =>
    Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());

  it.each([
    [0.9, 1.2816],
    [0.95, 1.6449],
    [0.99, 2.3263],
  ])('target %f is met within ±1 point', (target, z) => {
    const draw = normal(rng(42));
    const d = 10;
    const sigmaE = 4;
    const lead = { meanDays: 8, stdDays: 1.5 };
    const ss = safetyStock(z, sigmaE, d, lead).value;
    const cycles = 40_000;
    let covered = 0;
    for (let i = 0; i < cycles; i++) {
      const L = lead.meanDays + lead.stdDays * draw();
      // demand over a lead time of L days: d·L plus the sum of L daily errors (variance L·σe²)
      const demand = d * L + Math.sqrt(Math.max(L, 0)) * sigmaE * draw();
      if (demand <= d * lead.meanDays + ss) covered++;
    }
    expect(Math.abs(covered / cycles - target)).toBeLessThanOrEqual(0.01);
  });
});

describe('stockoutDay — first forecast day whose cumulative demand exceeds the position (2d-1)', () => {
  const flat = Array(14).fill(10);

  it('flat forecast (checked by hand)', () => {
    // 25 units: day 1 → 10, day 2 → 20, day 3 → 30 > 25 → runs out on day 3
    expect(stockoutDay(flat, 25, 25, 90)).toEqual({ day: 3, beyondForecast: false });
    // exactly 20 lasts days 1 and 2; day 3 is the first day with unmet demand
    expect(stockoutDay(flat, 20, 20, 90)).toEqual({ day: 3, beyondForecast: false });
    expect(stockoutDay(flat, 5, 5, 90)).toEqual({ day: 1, beyondForecast: false });
  });

  it('uneven forecast: uses each day, not the average', () => {
    // 2, 2, 20 …: 4 units last two days, the big day 3 empties 23
    expect(stockoutDay([2, 2, 20, 1], 23, 23, 90)).toEqual({ day: 3, beyondForecast: false });
    expect(stockoutDay([2, 2, 20, 1], 24, 24, 90)).toEqual({ day: 4, beyondForecast: false });
  });

  it('counts inbound stock in the position, but nothing available is out of stock now', () => {
    expect(stockoutDay(flat, 10, 45, 90)).toEqual({ day: 5, beyondForecast: false });
    expect(stockoutDay(flat, 0, 100, 90)).toEqual({ day: 0, beyondForecast: false });
    expect(stockoutDay(flat, -3, 0, 90)).toEqual({ day: 0, beyondForecast: false });
  });

  it('beyond the horizon uses the horizon average and says so; nothing past the cap', () => {
    // 14 days × 10 = 140; average 10 → 205 units run out on day 21
    expect(stockoutDay(flat, 205, 205, 90)).toEqual({ day: 21, beyondForecast: true });
    expect(stockoutDay(flat, 900, 900, 90)).toEqual({ day: null, beyondForecast: false }); // day 91
    expect(stockoutDay(flat, 899, 899, 90)).toEqual({ day: 90, beyondForecast: true });
  });

  it('no demand forecast → no stockout date', () => {
    expect(stockoutDay(Array(14).fill(0), 5, 5, 90)).toEqual({ day: null, beyondForecast: false });
    expect(stockoutDay([], 5, 5, 90)).toEqual({ day: null, beyondForecast: false });
  });

  it('turns a forecast day into a date after the last day of data', () => {
    expect(dayToDate('2026-11-17', 1)).toBe('2026-11-18');
    expect(dayToDate('2026-11-17', 0)).toBe('2026-11-17');
    expect(dayToDate('2026-12-30', 3)).toBe('2027-01-02');
  });
});

describe('reviewReason — when a person should set the quantity (2d-1)', () => {
  it.each([
    [true, 'AX', 'FALLBACK_FORECAST'],
    [true, 'CZ', 'FALLBACK_FORECAST'], // both apply: the fallback is the more basic problem
    [true, null, 'FALLBACK_FORECAST'],
    [false, 'AZ', 'ERRATIC_DEMAND'],
    [false, 'BZ', 'ERRATIC_DEMAND'],
    [false, 'CZ', 'ERRATIC_DEMAND'],
    [false, 'AX', null],
    [false, 'CY', null],
    [false, 'NEW', null],
    [false, null, null],
  ])('fallback %s, class %s → %s', (fallback, cls, expected) => {
    expect(reviewReason(fallback, cls)).toBe(expected);
  });
});

describe('explain — stockout and review sentences (2d-1)', () => {
  const ctx = {
    sku: 'RP-00042',
    locationCode: 'STR-01',
    model: 'hgb_direct',
    isFallback: false,
    sigmaError: 3,
    cls: 'CZ',
    serviceLevel: 0.9,
    serviceLevelZ: 1.2816,
    reviewPeriodDays: 7,
    packSize: 12,
    available: 20,
    inbound: 0,
  };
  const p = planned(base({ dcs: [dc(500)] }));

  it('states the expected stockout date, out of stock now, or none within 90 days', () => {
    const at = (stockout: { day: number | null; date: string | null; beyondForecast: boolean }) =>
      explain(p, { ...ctx, stockout });
    expect(at({ day: 3, date: '2026-11-20', beyondForecast: false })).toContain(
      'Expected stockout on 2026-11-20 (forecast day 3).',
    );
    expect(at({ day: 21, date: '2026-12-08', beyondForecast: true })).toContain(
      'an estimate beyond the forecast horizon',
    );
    expect(at({ day: 0, date: '2026-11-17', beyondForecast: false })).toContain(
      'Out of stock now.',
    );
    expect(at({ day: null, date: null, beyondForecast: false })).toContain(
      'No stockout expected within 90 days',
    );
  });

  it('says why a manager must set the quantity', () => {
    expect(explain(p, { ...ctx, review: 'ERRATIC_DEMAND' })).toContain(
      'Manual review: demand for this product at this store is erratic (class Z)',
    );
    expect(explain(p, { ...ctx, review: null })).not.toContain('Manual review');
  });
});

describe('excessAt — what a store keeps and could give away (2d-2)', () => {
  const flat = Array(14).fill(2); // 2 a day → 120 units over 60 days

  it('keeps 60 days of demand; movable is rounded down to whole packs (checked by hand)', () => {
    // position 200 − keep 120 = 80 excess; all on the shelf; packs of 12 → 72
    expect(
      excessAt({
        yhat: flat,
        available: 200,
        inbound: 0,
        promisedOut: 0,
        packSize: 12,
        keepDays: 60,
        reorderPoint: 10,
      }),
    ).toEqual({ keep: 120, excess: 80, movable: 72 });
  });

  it('keeps at least its own reorder point', () => {
    expect(
      excessAt({
        yhat: flat,
        available: 200,
        inbound: 0,
        promisedOut: 0,
        packSize: 1,
        keepDays: 60,
        reorderPoint: 150,
      }),
    ).toEqual({ keep: 150, excess: 50, movable: 50 });
  });

  it('inbound counts towards the excess, but only stock on the shelf and not promised can move', () => {
    // position 100 + 100 = 200 → excess 80, but only 100 − 70 promised = 30 on the shelf → 24
    expect(
      excessAt({
        yhat: flat,
        available: 100,
        inbound: 100,
        promisedOut: 70,
        packSize: 12,
        keepDays: 60,
        reorderPoint: 0,
      }),
    ).toEqual({ keep: 120, excess: 80, movable: 24 });
  });

  it('nothing movable below one pack or without excess', () => {
    expect(
      excessAt({
        yhat: flat,
        available: 131,
        inbound: 0,
        promisedOut: 0,
        packSize: 12,
        keepDays: 60,
        reorderPoint: 0,
      }).movable,
    ).toBe(0); // 11 excess < one pack of 12
    expect(
      excessAt({
        yhat: flat,
        available: 100,
        inbound: 0,
        promisedOut: 0,
        packSize: 1,
        keepDays: 60,
        reorderPoint: 0,
      }),
    ).toEqual({ keep: 120, excess: -20, movable: 0 });
  });

  it('uses the same 60 days as the Overview\'s "excess" definition', () => {
    expect(REPLENISHMENT.excessKeepDays).toBe(OVERVIEW.excessCoverDays);
  });
});

describe('chooseDc — excess goes to the DC holding the least of the product', () => {
  it('least available first, ties by code', () => {
    const dcs = [
      { code: 'DC-SOUTH', available: 40 },
      { code: 'DC-NORTH', available: 12 },
      { code: 'DC-EAST', available: 12 },
    ];
    expect(chooseDc(dcs)?.code).toBe('DC-EAST');
    expect(chooseDc([])).toBeNull();
  });
});

describe("plan — another store's excess as the source (2d-2)", () => {
  const store = (availableNet: number, code = 'STR-03'): DcStock => ({
    locationId: code,
    code,
    availableNet,
  });

  it('uses a store whose excess covers the whole quantity, before any DC', () => {
    // same numbers as the DC transfer case: quantity 84
    const p = planned(base({ dcs: [dc(500)], storeExcess: [store(84)] }));
    expect(p.action).toBe('TRANSFER');
    expect(p.source).toEqual({
      locationId: 'STR-03',
      code: 'STR-03',
      availableNet: 84,
      kind: 'STORE',
    });
    expect(p.quantity).toBe(84);
    expect(p.leadTimeDays).toBe(2);
  });

  it('picks the store with the most excess; falls back to a DC when no store covers it all', () => {
    expect(
      planned(base({ storeExcess: [store(96, 'STR-04'), store(120, 'STR-05')] })).source?.code,
    ).toBe('STR-05');
    const dcInstead = planned(base({ dcs: [dc(500)], storeExcess: [store(72)] }));
    expect(dcInstead.source).toMatchObject({ code: 'DC-NORTH', kind: 'DC' });
  });

  it('store excess alone is enough for a transfer; too little goes to the supplier', () => {
    expect(planned(base({ storeExcess: [store(84)], supplier: null })).source?.kind).toBe('STORE');
    const po = planned(base({ storeExcess: [store(12)] }));
    expect(po.action).toBe('PURCHASE_ORDER');
    expect(po.dcShortfall).toBeNull();
  });

  it('explains a store-to-store transfer', () => {
    const p = planned(base({ storeExcess: [store(84)] }));
    const text = explain(p, {
      sku: 'RP-00042',
      locationCode: 'STR-01',
      model: 'hgb_direct',
      isFallback: false,
      sigmaError: 3,
      cls: null,
      serviceLevel: 0.95,
      serviceLevelZ: 1.645,
      reviewPeriodDays: 7,
      packSize: 12,
      available: 20,
      inbound: 0,
    });
    expect(text).toContain("Source: transfer from STR-03's excess — it can spare 84 units");
  });
});

describe('explainExcess', () => {
  it('shows keep, excess, movable and the destination with the numbers', () => {
    const text = explainExcess({
      sku: 'RP-00042',
      locationCode: 'STR-05',
      keepDays: 60,
      demandKeep: 120,
      reorderPoint: 10,
      available: 200,
      inbound: 0,
      promisedOut: 0,
      packSize: 12,
      keep: 120,
      excess: 80,
      movable: 72,
      destinationCode: 'DC-NORTH',
      destinationAvailable: 12,
    });
    expect(text).toContain(
      'over the next 60 days is 120 units and its reorder point is 10, so it keeps 120',
    );
    expect(text).toContain('excess = 200 − 120 = 80');
    expect(text).toContain('rounded down to packs of 12 = 72 units');
    expect(text).toContain('send the remaining excess to DC-NORTH');
  });
});
