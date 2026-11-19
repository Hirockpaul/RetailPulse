import type { AiService } from '../../core/ai/ai.service';
import { validateAiAnswer } from '../../core/ai/ai.validation';
import type { AuthUser } from '../../core/auth/auth.types';
import type { DatabaseService } from '../../core/database/database.service';
import type { ClassificationsService } from '../classifications/classifications.service';
import type { ForecastsService } from '../forecasts/forecasts.service';
import type { PurchasingService } from '../purchasing/purchasing.service';
import type { SuppliersService } from '../suppliers/suppliers.service';
import type { TransfersService } from '../transfers/transfers.service';
import type { ReplenishmentRepository } from './replenishment.repository';
import type { RecommendationDetail } from './replenishment.schemas';
import { ReplenishmentService } from './replenishment.service';
import { recommendationWords } from './replenishment.words';

const need: RecommendationDetail = {
  id: 'rec-1',
  status: 'PENDING',
  action: 'PURCHASE_ORDER',
  quantity: 60,
  risk: 'HIGH',
  daysOfCover: 2.8,
  expectedStockoutOn: '2026-11-23',
  reviewReason: null,
  approvedQuantity: null,
  generatedAt: new Date('2026-11-19T08:00:00Z'),
  forecastRunId: 'run-1',
  productId: 'product-1',
  sku: 'TEA-500',
  productName: 'Breakfast Tea 500g',
  packSize: 6,
  locationId: 'location-1',
  locationCode: 'STR-01',
  sourceLocationId: null,
  sourceCode: null,
  supplierId: 'supplier-1',
  supplierName: 'Harbor Provisions',
  destinationLocationId: null,
  destinationCode: null,
  decidedBy: null,
  decidedAt: null,
  decisionNote: 'Private manager note must stay local.',
  transferId: null,
  purchaseOrderId: null,
  explanation: 'Existing free-text formula must stay local.',
  inputs: {
    forecast: {
      runId: 'run-1',
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
      id: 'supplier-1',
      name: 'Harbor Provisions',
      unitCost: 3.5,
      leadTimeDays: 5,
      minOrderQty: 24,
    },
    dcShortfall: { code: 'DC-NORTH', availableNet: 12, needed: 60 },
  },
};

const buildService = (repo: object, ai: object) =>
  new ReplenishmentService(
    repo as ReplenishmentRepository,
    {} as ForecastsService,
    {} as TransfersService,
    {} as PurchasingService,
    {} as SuppliersService,
    {} as ClassificationsService,
    {} as DatabaseService,
    ai as AiService,
  );

describe('recommendationWords', () => {
  it('explains stock, forecast, safety stock, quantity, and supplier route from checked facts', () => {
    const prepared = recommendationWords(need);
    const text = prepared.template.claims.map((claim) => claim.text).join(' ');

    expect(prepared.facts).toEqual(
      expect.arrayContaining([
        { id: 'position', label: 'Inventory position', value: 14 },
        { id: 'lead_time_demand', label: 'Forecast demand during lead time', value: 30 },
        { id: 'safety_stock', label: 'Safety stock in units', value: 8 },
        { id: 'raw_quantity', label: 'Unrounded need in units', value: 59 },
        { id: 'quantity', label: 'Suggested quantity in units', value: 60 },
        { id: 'supplier', label: 'Supplier name', value: 'Harbor Provisions' },
      ]),
    );
    expect(text).toMatch(/inventory position of 14/i);
    expect(text).toMatch(/adds 8 units of safety stock.*reorder point of 38/i);
    expect(text).toMatch(/unrounded need is 59.*suggests 60/i);
    expect(text).toMatch(/purchase order from Harbor Provisions/i);
    expect(() =>
      validateAiAnswer(JSON.stringify(prepared.template), prepared.facts, 'recommendation'),
    ).not.toThrow();
  });

  it('explains excess redistribution without presenting it as a supplier order', () => {
    const prepared = recommendationWords({
      ...need,
      action: 'REDISTRIBUTE_EXCESS',
      quantity: 30,
      supplierId: null,
      supplierName: null,
      destinationLocationId: 'dc-1',
      destinationCode: 'DC-SOUTH',
      inputs: {
        kind: 'EXCESS',
        forecast: {
          runId: 'run-1',
          model: 'hgb_direct',
          isFallback: false,
          historyDays: 365,
          testWape: 0.516,
          avgDailyDemand: 1,
        },
        stock: {
          onHand: 100,
          reserved: 5,
          available: 95,
          inbound: 0,
          position: 95,
          promisedOut: 5,
        },
        excess: {
          keepDays: 60,
          demandKeep: 60,
          reorderPoint: 20,
          keep: 60,
          excess: 35,
          movable: 30,
          packSize: 6,
        },
        destination: { code: 'DC-SOUTH', available: 10 },
      },
    });
    const text = prepared.template.claims.map((claim) => claim.text).join(' ');

    expect(text).toMatch(/transferring 30 units to DC-SOUTH/i);
    expect(text).toMatch(/does not create a supplier order/i);
    expect(() =>
      validateAiAnswer(JSON.stringify(prepared.template), prepared.facts, 'recommendation'),
    ).not.toThrow();
  });

  it('rejects model wording that tries to make the manager decision', () => {
    const prepared = recommendationWords(need);
    expect(() =>
      validateAiAnswer(
        JSON.stringify({
          claims: [{ type: 'recommendation', text: 'Approve the 60-unit suggestion.' }],
        }),
        prepared.facts,
        'recommendation',
      ),
    ).toThrow('unsafe_language');
  });
});

describe('ReplenishmentService.explainInWords', () => {
  it('checks access and excludes notes, actor data, ids, and existing free text', async () => {
    const repo = { find: jest.fn().mockResolvedValue(need) };
    const ai = {
      explain: jest.fn().mockResolvedValue({
        source: 'ai',
        answer: { claims: [{ type: 'recommendation', text: 'Checked explanation.' }] },
      }),
    };
    const service = buildService(repo, ai);
    const user: AuthUser = {
      id: 'user-1',
      email: 'private@example.test',
      displayName: 'Private Manager',
      role: 'STORE_MANAGER',
      locationIds: ['location-1'],
    };

    await expect(
      service.explainInWords('rec-1', { user, correlationId: 'corr-1' }),
    ).resolves.toEqual({
      source: 'ai',
      claims: [{ type: 'recommendation', text: 'Checked explanation.' }],
    });

    const sent = JSON.stringify(ai.explain.mock.calls[0][0].facts);
    expect(sent).not.toContain(user.email);
    expect(sent).not.toContain(user.displayName);
    expect(sent).not.toContain('corr-1');
    expect(sent).not.toContain(need.decisionNote);
    expect(sent).not.toContain(need.explanation);
    expect(sent).not.toContain(need.id);
    expect(ai.explain).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', feature: 'recommendation' }),
    );
  });

  it('refuses an inaccessible store before calling AI', async () => {
    const repo = { find: jest.fn().mockResolvedValue(need) };
    const ai = { explain: jest.fn() };
    const service = buildService(repo, ai);
    const user: AuthUser = {
      id: 'user-2',
      email: 'store2@example.test',
      displayName: 'Store 2',
      role: 'STORE_MANAGER',
      locationIds: ['location-2'],
    };

    await expect(
      service.explainInWords('rec-1', { user, correlationId: 'corr-2' }),
    ).rejects.toMatchObject({ status: 403 });
    expect(ai.explain).not.toHaveBeenCalled();
  });
});
