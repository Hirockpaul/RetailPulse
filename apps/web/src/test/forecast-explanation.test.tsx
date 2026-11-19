import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ForecastExplanation } from '../components/ForecastExplanation';
import { fakeApi, STR1 } from './render';

const explanation = {
  run: {
    id: 'run-1',
    dataLabel: 'SYNTHETIC',
    finishedAt: '2026-11-19T08:00:00Z',
    historyEnd: '2026-11-19',
  },
  servedModel: 'hgb_direct',
  productName: 'Breakfast Tea 500g',
  locationCode: 'STR-01',
  status: 'OK',
  explanation: {
    horizonDay: 1,
    targetDay: '2026-11-20',
    startingPoint: 3,
    forecast: 4.9,
    range80: { lower: 3.1, upper: 6.4, measuredCoverage: 0.79 },
    range95: { lower: 1.2, upper: 8.5, measuredCoverage: 0.946 },
    factors: [
      {
        feature: 'mean_56d',
        label: 'Average sales, last 56 days',
        display: '6.2 per day',
        contribution: 0.4,
        factor: 1.5,
      },
    ],
  },
  ranges: [],
  globalImportance: [],
};

describe('forecast explanation in words', () => {
  it('requests an explanation only after the button is pressed and labels template output', async () => {
    const spy = fakeApi('ANALYST', {
      '/forecasts/explanation/words': {
        body: {
          source: 'template',
          claims: [
            {
              type: 'prediction',
              text: 'Breakfast Tea 500g at STR-01 is forecast at 4.9 units.',
            },
          ],
        },
      },
      '/forecasts/explanation': { body: explanation },
    });
    render(<ForecastExplanation productId="product-1" locationId={STR1} />);

    const button = await screen.findByRole('button', { name: 'Explain in words' });
    expect(spy.mock.calls.some(([url]) => String(url).includes('/explanation/words'))).toBe(false);

    await userEvent.click(button);

    expect(await screen.findByText('Template explanation')).toBeInTheDocument();
    expect(screen.getByText('prediction')).toBeInTheDocument();
    expect(screen.getByText(/forecast at 4.9 units/)).toBeInTheDocument();
    const wordsCall = spy.mock.calls.find(([url]) => String(url).includes('/explanation/words'));
    expect(wordsCall?.[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(wordsCall?.[1]?.body))).toEqual({
      productId: 'product-1',
      locationId: STR1,
    });
  });

  it('shows the provider for AI-generated wording', async () => {
    fakeApi('ANALYST', {
      '/forecasts/explanation/words': {
        body: {
          source: 'ai',
          provider: 'nvidia',
          claims: [{ type: 'prediction', text: 'The forecast is 4.9 units.' }],
        },
      },
      '/forecasts/explanation': { body: explanation },
    });
    render(<ForecastExplanation productId="product-1" locationId={STR1} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Explain in words' }));

    expect(await screen.findByText('AI-generated explanation (NVIDIA)')).toBeInTheDocument();
  });
});
