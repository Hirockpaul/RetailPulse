import { csvField, csvFileName, reportRows, toCsv } from './reports.csv';
import type { ReportContent } from './reports.schemas';

const content = (over: Partial<ReportContent> = {}): ReportContent => ({
  kind: 'DAILY',
  periodStart: '2026-11-17',
  periodEnd: '2026-11-17',
  scope: { locationId: 'l1', code: 'STR-01', name: 'Riverside Store', type: 'STORE' },
  generatedAt: '2026-11-18T09:00:00.000Z',
  dataLabel: 'SYNTHETIC',
  sales: {
    unitsSold: 12,
    unitsReturned: 1,
    salesValueAtPrice: 34.5,
    byStore: [{ locationId: 'l1', code: 'STR-01', unitsSold: 12, valueAtPrice: 34.5 }],
    topProducts: [
      {
        productId: 'p1',
        sku: 'RP-00001',
        name: 'Cola, "Large"',
        unitsSold: 12,
        valueAtPrice: 34.5,
      },
    ],
  },
  movements: {
    receipts: 10,
    transfersIn: 0,
    transfersOut: 0,
    returns: 1,
    adjustmentsNet: -2,
    adjustmentsRemoved: 2,
  },
  work: {
    transfersRequested: 0,
    transfersDispatched: 0,
    transfersReceived: 0,
    purchaseOrdersCreated: 0,
    purchaseOrdersReceived: 0,
    recommendationsGenerated: 3,
    recommendationsApproved: 1,
    recommendationsRejected: 0,
    alertsOpened: 2,
    anomaliesFound: 0,
    anomaliesReviewed: 0,
  },
  stockAtGeneration: {
    asOf: '2026-11-18T09:00:00.000Z',
    positions: 200,
    onHand: 6341,
    available: 6300,
    valueAtCost: 19317.94,
    outOfStock: 27,
    atRisk7: 35,
    atRisk14: 60,
    excessPositions: 26,
    excessValueAtCost: 1116.92,
  },
  ...over,
});

describe('report CSV (V2 4c-1)', () => {
  it('quotes only when needed and doubles inner quotes (RFC 4180)', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField(12.5)).toBe('12.5');
    expect(csvField(null)).toBe('');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line\nbreak')).toBe('"line\nbreak"');
  });

  it('one row per number, under a fixed header, with CRLF line ends', () => {
    const csv = toCsv(content());
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('section,metric,location,product,value');
    expect(lines.at(-1)).toBe(''); // trailing CRLF
    // 5 report + 3 sales + 2 per store + 1 top product + 6 movements + 11 work + 10 stock
    expect(reportRows(content())).toHaveLength(5 + 3 + 2 + 1 + 6 + 11 + 10);
    expect(lines).toContain('sales,units_sold,STR-01,,12');
    expect(lines).toContain('top_products,units_sold,STR-01,"RP-00001 Cola, ""Large""",12');
    expect(lines).toContain('movements,adjustments_net,STR-01,,-2');
    expect(lines).toContain('stock_at_generation,at_risk_7,STR-01,,35');
    expect(lines).toContain('stock_at_generation,value_at_cost,STR-01,,19317.94');
  });

  it('names network reports and weekly periods in the file name', () => {
    expect(csvFileName(content())).toBe('retailpulse-daily-STR-01-2026-11-17.csv');
    expect(
      csvFileName(
        content({
          kind: 'WEEKLY',
          periodStart: '2026-11-16',
          periodEnd: '2026-11-22',
          scope: null,
        }),
      ),
    ).toBe('retailpulse-weekly-network-2026-11-16_to_2026-11-22.csv');
    expect(toCsv(content({ scope: null }))).toContain('sales,units_sold,NETWORK,,12');
  });
});
