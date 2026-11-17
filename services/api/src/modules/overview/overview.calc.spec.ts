import { type PositionRow, summarizePositions } from './overview.calc';

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
