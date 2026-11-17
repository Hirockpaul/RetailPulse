import {
  type DcStock,
  demandOver,
  explain,
  plan,
  type PlanInput,
  roundUpToMultiple,
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

/** 10 units/day forecast for 14 days, σ = 3, packs of 12 — easy numbers to check by hand. */
const base = (over: Partial<PlanInput> = {}): PlanInput => ({
  yhat: Array(14).fill(10),
  sigmaDaily: 3,
  packSize: 12,
  available: 20,
  inbound: 0,
  supplier,
  dcs: [],
  serviceLevelZ: 1.645,
  reviewPeriodDays: 7,
  transferLeadTimeDays: 2,
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

  it('rounds fractional days up', () => {
    expect(demandOver([10, 10, 10], 1.2)).toBe(20);
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
        sigmaDaily: 0,
        available: 3,
        supplier: { ...supplier, minOrderQty: 30 },
      }),
    );
    expect(tiny.rawQuantity).toBe(11); // 14 − 3
    expect(tiny.quantity).toBe(36); // 12 would be below the minimum of 30 → 36
  });

  it('suggests nothing when there is no demand', () => {
    expect(plan(base({ yhat: Array(14).fill(0), sigmaDaily: 0, available: 0 }))).toEqual({
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
    sigmaDaily: 3,
    serviceLevelZ: 1.645,
    reviewPeriodDays: 7,
    packSize: 12,
    available: 20,
    inbound: 0,
  };

  it('shows every step of a transfer with the numbers', () => {
    const text = explain(planned(base({ dcs: [dc(500)] })), ctx);
    expect(text).toContain('RP-00042 at STR-01 over the next 2 days: 20 units');
    expect(text).toContain('1.645 × 3 (daily demand spread) × √2 = 7');
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
    expect(text).toContain('order from Harbor Provisions (synthetic), lead time 7 days');
    expect(text).toContain('= 144 units');
  });

  it('says when the forecast is only a category-average fallback', () => {
    const text = explain(planned(base()), { ...ctx, isFallback: true, model: 'category_average' });
    expect(text).toContain(
      'category-average fallback because this product has little sales history',
    );
  });
});
