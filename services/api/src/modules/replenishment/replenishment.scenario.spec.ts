import type { DcStock } from './replenishment.calc';
import { applyScenario, summarizeBatch } from './replenishment.scenario';
import type { NewRecommendation, PairRow } from './replenishment.schemas';
import type { BatchInputs } from './replenishment.service';

const pair = (over: Partial<PairRow> = {}): PairRow =>
  ({
    productId: 'p1',
    locationId: 's1',
    locationCode: 'STR-01',
    sku: 'RP-1',
    productName: 'P',
    packSize: 12,
    model: 'm',
    isFallback: false,
    historyDays: 300,
    testWape: 0.3,
    sigmaError: 3,
    yhat: [10, 20],
    onHand: 5,
    reserved: 0,
    inbound: 0,
    promisedOut: 0,
    supplierId: 'sup',
    supplierName: 'S',
    leadTimeDays: 7,
    minOrderQty: 1,
    unitCost: 2,
    ...over,
  }) as PairRow;

const inputs = (): BatchInputs => ({
  run: { id: 'r', historyEnd: '2026-11-17' },
  pairs: [pair(), pair({ productId: 'p2', leadTimeDays: null })],
  dcByProduct: new Map<string, DcStock[]>([
    ['p1', [{ locationId: 'dc', code: 'DC-N', availableNet: 9 }]],
  ]),
  delays: new Map(),
  classified: { runId: null, classes: new Map() },
  dcLocations: [{ id: 'dc', code: 'DC-N' }],
});

describe('applyScenario (V2 4b-1)', () => {
  it('scales forecast and error, adds supplier days, cuts DC stock (checked by hand)', () => {
    const base = inputs();
    const out = applyScenario(base, {
      demandPct: 20,
      supplierLeadTimeDays: 3,
      dcAvailabilityPct: 50,
    });
    expect(out.pairs[0].yhat[0]).toBeCloseTo(12, 9);
    expect(out.pairs[0].yhat[1]).toBeCloseTo(24, 9);
    expect(out.pairs[0].sigmaError).toBeCloseTo(3.6, 9);
    expect(out.pairs[0].leadTimeDays).toBe(10);
    expect(out.pairs[1].leadTimeDays).toBeNull(); // no supplier terms: nothing to lengthen
    expect(out.dcByProduct.get('p1')![0].availableNet).toBe(4); // 9 × 0.5 = 4.5 → 4
    // The loaded snapshot is never modified (the baseline is computed from it too).
    expect(base.pairs[0].yhat).toEqual([10, 20]);
    expect(base.pairs[0].sigmaError).toBe(3);
    expect(base.dcByProduct.get('p1')![0].availableNet).toBe(9);
  });

  it('limits: −50 % halves demand, DC −100 % leaves nothing, a zero scenario changes nothing', () => {
    const half = applyScenario(inputs(), {
      demandPct: -50,
      supplierLeadTimeDays: 0,
      dcAvailabilityPct: 100,
    });
    expect(half.pairs[0].yhat).toEqual([5, 10]);
    expect(half.dcByProduct.get('p1')![0].availableNet).toBe(0);
    const zero = applyScenario(inputs(), {
      demandPct: 0,
      supplierLeadTimeDays: 0,
      dcAvailabilityPct: 0,
    });
    expect(zero.pairs).toEqual(inputs().pairs);
    expect([...zero.dcByProduct]).toEqual([...inputs().dcByProduct]);
  });
});

describe('summarizeBatch', () => {
  const rec = (over: Partial<NewRecommendation>): NewRecommendation =>
    ({
      forecastRunId: 'r',
      productId: 'p1',
      locationId: 's1',
      action: 'TRANSFER',
      sourceLocationId: 'dc',
      supplierId: null,
      destinationLocationId: null,
      quantity: 12,
      risk: 'HIGH',
      daysOfCover: 1,
      expectedStockoutOn: null,
      reviewReason: null,
      explanation: '',
      inputs: { source: { code: 'DC-N', availableNet: 9, kind: 'DC' }, supplier: null },
      ...over,
    }) as NewRecommendation;

  it('counts, units, purchase-order value at cost and transfer sources (checked by hand)', () => {
    const recommendations = [
      rec({}),
      rec({
        quantity: 24,
        inputs: {
          source: { code: 'STR-02', availableNet: 30, kind: 'STORE' },
          supplier: null,
        } as never,
      }),
      rec({
        action: 'PURCHASE_ORDER',
        quantity: 36,
        risk: 'CRITICAL',
        reviewReason: 'FALLBACK_FORECAST',
        inputs: {
          source: null,
          supplier: { id: 's', name: 'S', unitCost: 1.25, leadTimeDays: 7, minOrderQty: 1 },
        } as never,
      }),
      rec({
        action: 'REDISTRIBUTE_EXCESS',
        quantity: 48,
        risk: null,
        inputs: { kind: 'EXCESS' } as never,
      }),
    ];
    const s = summarizeBatch(
      {
        recommendations,
        result: {
          forecastRunId: 'r',
          forecastHistoryEnd: null,
          evaluated: 2,
          created: 4,
          expired: 0,
          byAction: { TRANSFER: 2, PURCHASE_ORDER: 1, REDISTRIBUTE_EXCESS: 1 },
          byRisk: { CRITICAL: 1, HIGH: 2 },
          fromStoreExcess: 1,
          skipped: { noNeed: 0, noSource: 0 },
        },
        stats: { outOfStockNow: 1, stockoutWithin7: 2, stockoutWithin14: 3 },
      },
      [pair(), pair()],
    );
    expect(s).toEqual({
      recommendations: 4,
      byAction: { TRANSFER: 2, PURCHASE_ORDER: 1, REDISTRIBUTE_EXCESS: 1 },
      byRisk: { CRITICAL: 1, HIGH: 2 },
      flaggedForReview: 1,
      units: { TRANSFER: 36, PURCHASE_ORDER: 36, REDISTRIBUTE_EXCESS: 48 },
      transfersFromDc: 1,
      fromStoreExcess: 1,
      purchaseOrderValueAtCost: 45, // 36 × 1.25
      positions: 2,
      outOfStockNow: 1,
      stockoutWithin7: 2,
      stockoutWithin14: 3,
    });
  });
});
