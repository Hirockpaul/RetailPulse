import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ReportDetailPage } from '../pages/ReportsPage';
import { fakeApi, renderSignedIn } from './render';

const report = {
  id: 'report-1',
  kind: 'DAILY',
  periodStart: '2026-11-18',
  periodEnd: '2026-11-18',
  locationId: null,
  locationCode: null,
  trigger: 'SCHEDULED',
  generatedBy: null,
  generatedAt: '2026-11-19T08:00:00Z',
  durationMs: 25,
  content: {
    kind: 'DAILY',
    periodStart: '2026-11-18',
    periodEnd: '2026-11-18',
    scope: null,
    generatedAt: '2026-11-19T08:00:00Z',
    dataLabel: 'SYNTHETIC',
    sales: {
      unitsSold: 42,
      unitsReturned: 1,
      salesValueAtPrice: 210,
      byStore: [],
      topProducts: [],
    },
    movements: {
      receipts: 10,
      transfersIn: 2,
      transfersOut: 3,
      returns: 1,
      adjustmentsNet: 0,
      adjustmentsRemoved: 0,
    },
    work: {
      transfersRequested: 0,
      transfersDispatched: 0,
      transfersReceived: 0,
      purchaseOrdersCreated: 0,
      purchaseOrdersReceived: 0,
      recommendationsGenerated: 2,
      recommendationsApproved: 1,
      recommendationsRejected: 0,
      alertsOpened: 1,
      anomaliesFound: 0,
      anomaliesReviewed: 0,
    },
    stockAtGeneration: {
      asOf: '2026-11-19T08:00:00Z',
      positions: 100,
      onHand: 1000,
      available: 950,
      valueAtCost: 5000,
      outOfStock: 2,
      atRisk7: 3,
      atRisk14: 5,
      excessPositions: 4,
      excessValueAtCost: 300,
    },
  },
};

describe('report summary in words', () => {
  it('loads only after the button is pressed and labels the provider', async () => {
    const spy = fakeApi('ANALYST', {
      '/reports/report-1/summary/words': {
        body: {
          source: 'ai',
          provider: 'nvidia',
          claims: [{ type: 'fact', text: 'The report records 42 units sold.' }],
        },
      },
      '/reports/report-1': { body: report },
    });
    renderSignedIn(<ReportDetailPage id="report-1" />);

    const button = await screen.findByRole('button', { name: 'Summarise in words' });
    expect(spy.mock.calls.some(([url]) => String(url).includes('/summary/words'))).toBe(false);

    await userEvent.click(button);

    expect(await screen.findByText('AI-generated report summary (NVIDIA)')).toBeInTheDocument();
    expect(screen.getByText(/records 42 units sold/)).toBeInTheDocument();
    const wordsCall = spy.mock.calls.find(([url]) => String(url).includes('/summary/words'));
    expect(wordsCall?.[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(wordsCall?.[1]?.body))).toEqual({});
  });
});
