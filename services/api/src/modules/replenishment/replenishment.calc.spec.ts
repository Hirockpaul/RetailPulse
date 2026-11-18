import {
  type DcStock,
  demandOver,
  explain,
  plan,
  type PlanInput,
  roundUpToMultiple,
  safetyStock,
  serviceLevelFor,
  supplierLeadTime,
  type SupplierDelay,
  type SupplierTerms,
} from './replenishment.calc';

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
    expect(p.sourceDc).toBeNull();
  });

  it('counts inbound stock in the position', () => {
    const p = planned(base({ inbound: 60 }));
    expect(p.position).toBe(80); // 20 + 60, still below the 83.06 reorder point
    expect(p.quantity).toBe(Math.ceil((153.057 - 80) / 12) * 12); // 74 → 84
    expect(p.quantity).toBe(84);
  });

  it('does nothing when the position is at or above the reorder point', () => {
    expect(plan(base({ available: 84 }))).toEqual({ skip: 'NO_NEED' });
    expect(plan(base({ available: 30, inbound: 60 }))).toEqual({ skip: 'NO_NEED' });
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
    expect(plan(base({ yhat: Array(14).fill(0), sigmaError: 0, available: 0 }))).toEqual({
      skip: 'NO_NEED',
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
    expect(p.sourceDc?.code).toBe('DC-NORTH');
    expect(p.supplier).toBeNull();
    expect(p.dcShortfall).toBeNull();
  });

  it('picks the DC with the most unallocated stock', () => {
    const p = planned(
      base({ dcs: [dc(100, 'DC-SOUTH'), dc(900, 'DC-NORTH'), dc(300, 'DC-EAST')] }),
    );
    expect(p.sourceDc?.code).toBe('DC-NORTH');
  });

  it('does not recommend when stock already covers the short lead time', () => {
    // reorder point with the 2-day lead time is 26.979, so 27 is enough
    expect(plan(base({ dcs: [dc(500)], available: 27 }))).toEqual({ skip: 'NO_NEED' });
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
    expect(plan(base({ available: 0, inbound: 100, dcs: [dc(500)] }))).toEqual({ skip: 'NO_NEED' });
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
