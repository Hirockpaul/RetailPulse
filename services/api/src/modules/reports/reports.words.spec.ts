import type { AiService } from '../../core/ai/ai.service';
import { validateAiAnswer } from '../../core/ai/ai.validation';
import type { AuthUser } from '../../core/auth/auth.types';
import type { Env } from '../../core/config/env';
import type { OverviewService } from '../overview/overview.service';
import type { ReportsRepository } from './reports.repository';
import type { ReportContent, ReportDetail } from './reports.schemas';
import { ReportsService } from './reports.service';
import { reportWords } from './reports.words';

const content: ReportContent = {
  kind: 'WEEKLY',
  periodStart: '2026-11-09',
  periodEnd: '2026-11-15',
  scope: { locationId: 'location-1', code: 'STR-01', name: 'North Store', type: 'STORE' },
  generatedAt: '2026-11-16T08:00:00.000Z',
  dataLabel: 'SYNTHETIC',
  sales: {
    unitsSold: 142,
    unitsReturned: 3,
    salesValueAtPrice: 981.257,
    byStore: [
      { locationId: 'location-1', code: 'STR-01', unitsSold: 142, valueAtPrice: 981.257 },
      { locationId: 'location-2', code: 'STR-02', unitsSold: 100, valueAtPrice: 700 },
      { locationId: 'location-3', code: 'STR-03', unitsSold: 80, valueAtPrice: 500 },
      { locationId: 'location-private', code: 'STR-04', unitsSold: 50, valueAtPrice: 300 },
    ],
    topProducts: [
      {
        productId: 'product-1',
        sku: 'TEA-500',
        name: 'Breakfast Tea',
        unitsSold: 31,
        valueAtPrice: 120,
      },
      {
        productId: 'product-2',
        sku: 'COF-250',
        name: 'Ground Coffee',
        unitsSold: 28,
        valueAtPrice: 150,
      },
      {
        productId: 'product-3',
        sku: 'OAT-1KG',
        name: 'Porridge Oats',
        unitsSold: 20,
        valueAtPrice: 50,
      },
      {
        productId: 'product-private',
        sku: 'MIL-1L',
        name: 'Milk',
        unitsSold: 12,
        valueAtPrice: 20,
      },
    ],
  },
  movements: {
    receipts: 200,
    transfersIn: 20,
    transfersOut: 15,
    returns: 3,
    adjustmentsNet: -2,
    adjustmentsRemoved: 2,
  },
  work: {
    transfersRequested: 5,
    transfersDispatched: 4,
    transfersReceived: 3,
    purchaseOrdersCreated: 2,
    purchaseOrdersReceived: 1,
    recommendationsGenerated: 9,
    recommendationsApproved: 4,
    recommendationsRejected: 1,
    alertsOpened: 6,
    anomaliesFound: 2,
    anomaliesReviewed: 1,
  },
  stockAtGeneration: {
    asOf: '2026-11-16T08:00:00.000Z',
    positions: 200,
    onHand: 3200,
    available: 3100,
    valueAtCost: 8600,
    outOfStock: 4,
    atRisk7: 7,
    atRisk14: 12,
    excessPositions: 5,
    excessValueAtCost: 900,
  },
};

const detail: ReportDetail = {
  id: 'report-1',
  kind: 'WEEKLY',
  periodStart: content.periodStart,
  periodEnd: content.periodEnd,
  locationId: 'location-1',
  locationCode: 'STR-01',
  trigger: 'MANUAL',
  generatedBy: 'private@example.test',
  generatedAt: new Date(content.generatedAt),
  durationMs: 42,
  content,
};

describe('reportWords', () => {
  it('builds a checked summary from minimum aggregate facts', () => {
    const prepared = reportWords(content);
    const sent = JSON.stringify(prepared.facts);

    expect(() =>
      validateAiAnswer(JSON.stringify(prepared.template), prepared.facts, 'report'),
    ).not.toThrow();
    expect(prepared.facts).toEqual(
      expect.arrayContaining([
        { id: 'units_sold', label: 'Units sold', value: 142 },
        {
          id: 'sales_value',
          label: 'Sales value at prices when the report was generated',
          value: 981.26,
        },
        { id: 'product_1_name', label: 'Leading product 1 name', value: 'Breakfast Tea' },
        { id: 'at_risk_7', label: 'Positions forecast to run out within 7 days', value: 7 },
      ]),
    );
    expect(sent).not.toContain('location-1');
    expect(sent).not.toContain('product-1');
    expect(sent).not.toContain('location-private');
    expect(sent).not.toContain('product-private');
    expect(prepared.template.claims.at(-1)?.text).toMatch(/actual outcomes may differ/i);
  });

  it('uses an unknown claim when forecast-derived stock figures are unavailable', () => {
    const prepared = reportWords({
      ...content,
      stockAtGeneration: {
        ...content.stockAtGeneration,
        atRisk7: null,
        atRisk14: null,
        excessPositions: null,
      },
    });

    expect(prepared.template.claims.at(-1)).toEqual({
      type: 'unknown',
      text: 'Forecast-based stock risk and excess figures were not available for this report.',
    });
    expect(() =>
      validateAiAnswer(JSON.stringify(prepared.template), prepared.facts, 'report'),
    ).not.toThrow();
  });

  it('rejects certainty wording for forecast-based report claims', () => {
    const prepared = reportWords(content);
    expect(() =>
      validateAiAnswer(
        JSON.stringify({
          claims: [{ type: 'prediction', text: 'Exactly 7 positions will definitely run out.' }],
        }),
        prepared.facts,
        'report',
      ),
    ).toThrow('unsafe_language');
  });
});

describe('ReportsService.summarizeInWords', () => {
  const user: AuthUser = {
    id: 'user-1',
    email: 'private@example.test',
    displayName: 'Private Manager',
    role: 'STORE_MANAGER',
    locationIds: ['location-1'],
  };

  it('checks access, calls only the AI wording path, and leaves the report unchanged', async () => {
    const repo = {
      find: jest.fn().mockResolvedValue(detail),
      save: jest.fn(() => {
        throw new Error('must not write');
      }),
    };
    const ai = {
      explain: jest.fn().mockResolvedValue({
        source: 'ai',
        provider: 'nvidia',
        answer: { claims: [{ type: 'fact', text: 'Checked summary.' }] },
      }),
    };
    const service = new ReportsService(
      repo as unknown as ReportsRepository,
      {} as OverviewService,
      { HOUSEKEEPING_ENABLED: false } as Env,
      ai as unknown as AiService,
    );

    await expect(service.summarizeInWords('report-1', user)).resolves.toEqual({
      source: 'ai',
      provider: 'nvidia',
      claims: [{ type: 'fact', text: 'Checked summary.' }],
    });
    expect(repo.save).not.toHaveBeenCalled();
    expect(ai.explain).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', feature: 'report' }),
    );
    const sent = JSON.stringify(ai.explain.mock.calls[0][0].facts);
    expect(sent).not.toContain(user.email);
    expect(sent).not.toContain(user.displayName);
    expect(sent).not.toContain(detail.id);
  });

  it('refuses an inaccessible report before calling AI', async () => {
    const repo = { find: jest.fn().mockResolvedValue(detail) };
    const ai = { explain: jest.fn() };
    const service = new ReportsService(
      repo as unknown as ReportsRepository,
      {} as OverviewService,
      { HOUSEKEEPING_ENABLED: false } as Env,
      ai as unknown as AiService,
    );

    await expect(
      service.summarizeInWords('report-1', { ...user, locationIds: ['location-2'] }),
    ).rejects.toMatchObject({ status: 403 });
    expect(ai.explain).not.toHaveBeenCalled();
  });
});
