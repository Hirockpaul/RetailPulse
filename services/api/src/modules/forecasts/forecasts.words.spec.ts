import { validateAiAnswer } from '../../core/ai/ai.validation';
import type { AiService } from '../../core/ai/ai.service';
import type { AuthUser } from '../../core/auth/auth.types';
import type { ForecastClient } from './forecast.client';
import type { ForecastsRepository } from './forecasts.repository';
import type { ForecastExplanation } from './forecasts.schemas';
import { ForecastsService } from './forecasts.service';
import { forecastWords, measuredCoverage } from './forecasts.words';

const ranges: ForecastExplanation['ranges'] = [
  {
    level: 80,
    forecastFrom: 0,
    forecastTo: 10,
    qLow: -2,
    qHigh: 3,
    testCoverage: 0.79,
    testPoints: 200,
  },
  {
    level: 95,
    forecastFrom: 0,
    forecastTo: 10,
    qLow: -4,
    qHigh: 5,
    testCoverage: 0.946,
    testPoints: 200,
  },
];

describe('forecastWords', () => {
  it('builds a number-checked template from only the verified forecast facts', () => {
    const prepared = forecastWords({
      productName: 'Breakfast Tea 500g',
      locationCode: 'STR-01',
      explanation: {
        horizonDay: 1,
        targetDay: '2026-11-20',
        startingPoint: 3,
        forecast: 4.86,
        range80: { lower: 3.1, upper: 6.4, measuredCoverage: 0.79 },
        range95: { lower: 1.2, upper: 8.5, measuredCoverage: 0.946 },
        factors: [
          {
            feature: 'mean_56d',
            label: 'Average sales, last 56 days',
            display: '6.2 per day',
            contribution: Math.log(1.5),
            factor: 1.5,
          },
          {
            feature: 'weekday',
            label: 'Day of the week',
            display: 'Friday',
            contribution: Math.log(1.2),
            factor: 1.2,
          },
        ],
      },
    });

    expect(prepared.facts).toEqual(
      expect.arrayContaining([
        { id: 'product', label: 'Product name', value: 'Breakfast Tea 500g' },
        { id: 'store', label: 'Store code', value: 'STR-01' },
        { id: 'forecast', label: 'Forecast units', value: 4.9 },
        { id: 'range_80_coverage', label: 'Measured coverage of the 80% range', value: '79%' },
        {
          id: 'range_95_coverage',
          label: 'Measured coverage of the 95% range',
          value: '94.6%',
        },
      ]),
    );
    expect(prepared.facts.map((fact) => fact.label).join(' ')).not.toMatch(/email|user name|note/i);
    expect(() =>
      validateAiAnswer(JSON.stringify(prepared.template), prepared.facts, 'forecast'),
    ).not.toThrow();
    expect(prepared.template.claims.map((claim) => claim.text).join(' ')).toContain(
      'not customer behaviour',
    );
  });

  it('selects measured coverage only from the matching forecast-level group', () => {
    expect(measuredCoverage(ranges, 80, 4.9)).toBe(0.79);
    expect(measuredCoverage(ranges, 95, 4.9)).toBe(0.946);
    expect(measuredCoverage(ranges, 80, 12)).toBeNull();
  });
});

describe('ForecastsService.explainInWords', () => {
  it('passes only backend-selected forecast facts to AI and returns its checked claims', async () => {
    const repo = {
      latestRun: jest.fn().mockResolvedValue({
        id: 'run-1',
        servedModel: 'hgb_direct',
        explanationStatus: 'OK',
        dataLabel: 'SYNTHETIC',
        finishedAt: new Date('2026-11-19T08:00:00Z'),
        historyEnd: '2026-11-19',
      }),
      explanation: jest.fn().mockResolvedValue({
        isFallback: false,
        productName: 'Breakfast Tea 500g',
        categoryName: 'Tea',
        locationCode: 'STR-01',
        row: {
          horizonDay: 1,
          targetDay: '2026-11-20',
          baseLog: Math.log(3),
          forecast: 4.86,
          lower: 3.1,
          upper: 6.4,
          lower95: 1.2,
          upper95: 8.5,
          contributions: [{ feature: 'mean_56d', value: 6.2, contribution: Math.log(1.5) }],
        },
      }),
      featureImportance: jest.fn().mockResolvedValue([]),
      ranges: jest.fn().mockResolvedValue(ranges),
    };
    const ai = {
      explain: jest.fn().mockResolvedValue({
        source: 'ai',
        answer: { claims: [{ type: 'prediction', text: 'Checked AI explanation.' }] },
      }),
    };
    const service = new ForecastsService(
      repo as unknown as ForecastsRepository,
      {} as ForecastClient,
      ai as unknown as AiService,
    );
    const user: AuthUser = {
      id: 'user-1',
      email: 'private@example.test',
      displayName: 'Private Manager',
      role: 'ANALYST',
      locationIds: [],
    };

    await expect(
      service.explainInWords(
        { productId: 'product-1', locationId: 'location-1' },
        { user, correlationId: 'corr-1' },
      ),
    ).resolves.toEqual({
      source: 'ai',
      claims: [{ type: 'prediction', text: 'Checked AI explanation.' }],
    });

    expect(ai.explain).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        feature: 'forecast',
        facts: expect.arrayContaining([
          { id: 'product', label: 'Product name', value: 'Breakfast Tea 500g' },
          { id: 'store', label: 'Store code', value: 'STR-01' },
        ]),
      }),
    );
    const sent = JSON.stringify(ai.explain.mock.calls[0][0].facts);
    expect(sent).not.toContain(user.email);
    expect(sent).not.toContain(user.displayName);
    expect(sent).not.toContain('corr-1');
  });
});
