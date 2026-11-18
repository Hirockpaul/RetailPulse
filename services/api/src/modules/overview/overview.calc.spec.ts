import {
  atRiskWithin,
  classifyPosition,
  healthByStore,
  type PositionRow,
  summarizePositions,
} from './overview.calc';

const cfg = { riskWindowDays: 7, excessCoverDays: 60, topN: 2 };

const row = (over: Partial<PositionRow>): PositionRow => ({
  productId: 'p',
  sku: 'SKU-1',
  productName: 'Product',
  locationId: 'l',
  locationCode: 'STR-01',
  available: 20,
  inbound: 0,
  demandWindow: 14, // 2 units/day for 7 days
  avgDaily: 2,
  ...over,
});

describe('summarizePositions', () => {
  it('counts out-of-stock positions even without a forecast', () => {
    const s = summarizePositions(
      [row({ available: 0 }), row({ available: -1, demandWindow: null, avgDaily: null })],
      cfg,
    );
    expect(s.outOfStock).toBe(2);
    expect(s.withoutForecast).toBe(1);
    expect(s.atRisk).toBe(0); // out of stock is reported separately, not as "at risk"
  });

  it('flags at risk when available + inbound is below the demand of the risk window', () => {
    const s = summarizePositions(
      [
        row({ sku: 'A', available: 10, inbound: 0 }), // 10 < 14 → at risk, 5 days of cover
        row({ sku: 'B', available: 10, inbound: 4 }), // 14 = 14 → covered
        row({ sku: 'C', available: 3, inbound: 0 }), // 3 < 14 → at risk, 1.5 days
      ],
      cfg,
    );
    expect(s.atRisk).toBe(2);
    expect(s.atRiskTop.map((i) => [i.sku, i.daysOfCover])).toEqual([
      ['C', 1.5],
      ['A', 5],
    ]);
  });

  it('flags excess above the cover limit and reports the surplus units', () => {
    const s = summarizePositions(
      [
        row({ sku: 'A', available: 150, avgDaily: 2 }), // limit 120 → 30 excess
        row({ sku: 'B', available: 120, avgDaily: 2 }), // exactly the limit → fine
        row({ sku: 'C', available: 5, inbound: 0, demandWindow: 0, avgDaily: 0 }), // no demand → 5 excess
      ],
      cfg,
    );
    expect(s.excess).toBe(2);
    expect(s.excessUnits).toBe(35);
    expect(s.excessTop.map((i) => [i.sku, i.excessUnits, i.daysOfCover])).toEqual([
      ['A', 30, 75],
      ['C', 5, null],
    ]);
  });

  it('limits the top lists but not the counts', () => {
    const rows = ['A', 'B', 'C'].map((sku) => row({ sku, available: 1 }));
    const s = summarizePositions(rows, cfg);
    expect(s.atRisk).toBe(3);
    expect(s.atRiskTop).toHaveLength(2);
  });
});

describe('Control Tower (V2 4a-1)', () => {
  /** 10 units a day: 7-day demand 70, 14-day 140, 60-day excess limit 600; cost 2 a unit. */
  const at = (over: Partial<PositionRow>) =>
    row({ demandWindow: 70, demandWindowLong: 140, avgDaily: 10, unitCost: 2, ...over });

  it('classifies each position once, in a fixed order (checked by hand)', () => {
    const cfg = { excessCoverDays: 60 };
    // 10 a day: 7-day demand 70, 60-day limit 600
    expect(classifyPosition(at({ available: 0, inbound: 900 }), cfg)).toEqual({
      state: 'OUT_OF_STOCK',
      excessUnits: 0,
    }); // nothing on the shelf beats any inbound
    expect(classifyPosition(at({ demandWindow: null, avgDaily: null }), cfg).state).toBe(
      'NO_FORECAST',
    );
    expect(classifyPosition(at({ available: 69 }), cfg).state).toBe('AT_RISK');
    expect(classifyPosition(at({ available: 70 }), cfg).state).toBe('HEALTHY');
    expect(classifyPosition(at({ available: 600 }), cfg).state).toBe('HEALTHY');
    expect(classifyPosition(at({ available: 590, inbound: 15 }), cfg)).toEqual({
      state: 'EXCESS',
      excessUnits: 5,
    });
  });

  it('counts states per store with excess value at cost', () => {
    const rows = [
      at({ locationId: 'b', locationCode: 'STR-02', available: 0 }),
      at({ locationId: 'a', locationCode: 'STR-01', available: 650, unitCost: 1.5 }), // 50 × 1.5
      at({ locationId: 'a', locationCode: 'STR-01', available: 610, unitCost: null }), // no cost
      at({ locationId: 'a', locationCode: 'STR-01', available: 100 }),
      at({ locationId: 'a', locationCode: 'STR-01', available: 20 }),
    ];
    expect(healthByStore(rows, { excessCoverDays: 60 })).toEqual([
      {
        locationId: 'a',
        locationCode: 'STR-01',
        outOfStock: 0,
        noForecast: 0,
        atRisk: 1,
        excess: 2,
        healthy: 1,
        excessUnits: 60,
        excessValue: 75,
      },
      {
        locationId: 'b',
        locationCode: 'STR-02',
        outOfStock: 1,
        noForecast: 0,
        atRisk: 0,
        excess: 0,
        healthy: 0,
        excessUnits: 0,
        excessValue: 0,
      },
    ]);
  });

  it('at risk within 7 and within 14 days', () => {
    const rows = [
      at({ available: 60 }), // < 70: both windows
      at({ available: 100 }), // 7-day fine, < 140 in 14 days
      at({ available: 200 }), // fine in both
      at({ available: 0 }), // out of stock is not "at risk"
      at({ demandWindow: null, demandWindowLong: null, avgDaily: null }), // no forecast
    ];
    expect(atRiskWithin(rows, 'short')).toBe(1);
    expect(atRiskWithin(rows, 'long')).toBe(2);
  });
});
