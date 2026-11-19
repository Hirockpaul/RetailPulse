import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AnomalyDetailPage } from '../pages/AnomalyDetailPage';
import { fakeApi, STR1 } from './render';

const finding = {
  id: 'finding-1',
  source: 'SALES',
  kind: 'SPIKE',
  severity: 'HIGH',
  status: 'NEW',
  day: '2026-11-18',
  productId: 'product-1',
  sku: 'TEA-500',
  productName: 'Breakfast Tea 500g',
  locationId: STR1,
  locationCode: 'STR-01',
  score: 10.2,
  observed: 24,
  expected: 4.2,
  explanation: 'Sold 24 units; about 4.2 were expected.',
  details: null,
  rule: 'robust_z v1',
  foundAt: '2026-11-19T08:00:00Z',
  reviewedAt: null,
  history: [],
  nextSteps: [],
};

describe('anomaly explanation in words', () => {
  it('requests an explanation only after the button is pressed and labels template output', async () => {
    const spy = fakeApi('ANALYST', {
      '/anomalies/finding-1/explanation/words': {
        body: {
          source: 'template',
          claims: [
            {
              type: 'fact',
              text: 'Breakfast Tea 500g at STR-01 recorded 24 units; about 4.2 were expected.',
            },
            {
              type: 'recommendation',
              text: 'Check for a promotion, duplicate sales, and the physical stock count.',
            },
          ],
        },
      },
      '/anomalies/finding-1': { body: finding },
    });
    render(<AnomalyDetailPage id="finding-1" />);

    const button = await screen.findByRole('button', { name: 'Explain in words' });
    expect(spy.mock.calls.some(([url]) => String(url).includes('/explanation/words'))).toBe(false);

    await userEvent.click(button);

    expect(await screen.findByText('Template explanation')).toBeInTheDocument();
    expect(screen.getByText('recommendation')).toBeInTheDocument();
    expect(screen.getByText(/promotion, duplicate sales/)).toBeInTheDocument();
    const wordsCall = spy.mock.calls.find(([url]) => String(url).includes('/explanation/words'));
    expect(wordsCall?.[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(wordsCall?.[1]?.body))).toEqual({});
  });
});
