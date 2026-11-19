import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { RecommendationDetailPage } from '../pages/RecommendationDetailPage';
import { fakeApi, renderSignedIn, STR1 } from './render';

const recommendation = {
  id: 'rec-1',
  status: 'PENDING',
  action: 'PURCHASE_ORDER',
  quantity: 60,
  risk: 'HIGH',
  daysOfCover: 2.8,
  expectedStockoutOn: '2026-11-23',
  reviewReason: null,
  approvedQuantity: null,
  generatedAt: '2026-11-19T08:00:00Z',
  forecastRunId: 'run-1',
  productId: 'product-1',
  sku: 'TEA-500',
  productName: 'Breakfast Tea 500g',
  packSize: 6,
  locationId: STR1,
  locationCode: 'STR-01',
  sourceLocationId: null,
  sourceCode: null,
  supplierId: 'supplier-1',
  supplierName: 'Harbor Provisions',
  destinationLocationId: null,
  destinationCode: null,
  decidedBy: null,
  decidedAt: null,
  decisionNote: null,
  transferId: null,
  purchaseOrderId: null,
  explanation: 'Stock position is below the reorder point. Order to the cover level.',
  inputs: {
    forecast: {
      model: 'hgb_direct',
      isFallback: false,
      historyDays: 365,
      testWape: 0.516,
      demandDuringLead: 30,
      demandDuringCover: 65,
      avgDailyDemand: 5,
      sigmaError: 2,
    },
    parameters: {
      serviceLevel: 0.97,
      classification: { cls: 'BY', runId: 'class-1' },
      serviceLevelZ: 1.88,
      reviewPeriodDays: 7,
      leadTimeDays: 6,
      leadTimeSource: 'supplier',
      leadTimeStdDays: 1.5,
      leadTimeBasis: 'measured',
      supplierDeliveries: 120,
      packSize: 6,
      minOrderQty: 24,
    },
    stock: { onHand: 12, reserved: 2, available: 10, inbound: 4, position: 14 },
    calculation: {
      safetyStock: 8,
      safetyStockParts: { demandVariance: 24, leadTimeVariance: 56.25 },
      reorderPoint: 38,
      orderUpTo: 73,
      rawQuantity: 59,
      quantity: 60,
      daysOfCover: 2.8,
    },
    stockout: { day: 4, date: '2026-11-23', beyondForecast: false },
    review: null,
    source: null,
    supplier: {
      name: 'Harbor Provisions',
      unitCost: 3.5,
      leadTimeDays: 5,
      minOrderQty: 24,
    },
    dcShortfall: { code: 'DC-NORTH', availableNet: 12, needed: 60 },
  },
};

describe('recommendation explanation in words', () => {
  it('requests an explanation only after the button is pressed and labels template output', async () => {
    const spy = fakeApi('ANALYST', {
      '/replenishment/recommendations/rec-1/explanation/words': {
        body: {
          source: 'template',
          claims: [
            {
              type: 'fact',
              text: 'The inventory position is 14 units.',
            },
            {
              type: 'recommendation',
              text: 'RetailPulse suggests a 60-unit supplier order after pack rounding.',
            },
          ],
        },
      },
      '/replenishment/recommendations/rec-1': { body: recommendation },
    });
    renderSignedIn(<RecommendationDetailPage id="rec-1" />);

    const button = await screen.findByRole('button', { name: 'Explain in words' });
    expect(spy.mock.calls.some(([url]) => String(url).includes('/explanation/words'))).toBe(false);

    await userEvent.click(button);

    expect(await screen.findByText('Template explanation')).toBeInTheDocument();
    expect(screen.getByText('recommendation')).toBeInTheDocument();
    expect(screen.getByText(/60-unit supplier order/)).toBeInTheDocument();
    const wordsCall = spy.mock.calls.find(([url]) => String(url).includes('/explanation/words'));
    expect(wordsCall?.[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(wordsCall?.[1]?.body))).toEqual({});
  });
});
