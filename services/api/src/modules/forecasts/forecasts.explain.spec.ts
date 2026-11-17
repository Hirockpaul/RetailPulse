import { describeFactor, featureLabel, monthOfDay } from './forecasts.explain';

const ctx = { categoryName: 'Dairy', locationCode: 'STR-01' };

describe('describeFactor', () => {
  it('turns a log contribution into a multiplying factor', () => {
    const f = describeFactor(
      { feature: 'mean_7d', value: 4.33, contribution: Math.log(1.25) },
      ctx,
    );
    expect(f).toMatchObject({ label: 'Average sales, last 7 days', display: '4.3 per day' });
    expect(f.factor).toBeCloseTo(1.25, 10);
  });

  it('factors multiply back to the forecast exactly', () => {
    const base = Math.log(2);
    const parts = [0.4, -0.1, 0.05].map((contribution, i) =>
      describeFactor({ feature: `f${i}`, value: 0, contribution }, ctx),
    );
    const forecast = Math.exp(base) * parts.reduce((p, f) => p * f.factor, 1);
    expect(forecast).toBeCloseTo(Math.exp(base + 0.35), 10);
  });

  it('shows weekday, store, category, promotion and time of year in words', () => {
    expect(describeFactor({ feature: 'weekday', value: 5, contribution: 0 }, ctx).display).toBe(
      'Saturday',
    );
    expect(describeFactor({ feature: 'store', value: 3, contribution: 0 }, ctx).display).toBe(
      'STR-01',
    );
    expect(describeFactor({ feature: 'category', value: 1, contribution: 0 }, ctx).display).toBe(
      'Dairy',
    );
    expect(
      describeFactor({ feature: 'promo_target', value: 1, contribution: 0 }, ctx).display,
    ).toBe('no');
    expect(
      describeFactor({ feature: 'promo_target', value: 1.6, contribution: 0 }, ctx).display,
    ).toBe('yes (× 1.6 expected)');
    expect(describeFactor({ feature: 'season', value: 322, contribution: 0 }, ctx).display).toBe(
      'November',
    );
  });

  it('keeps unknown inputs readable instead of failing', () => {
    expect(
      describeFactor({ feature: 'new_feature', value: 2.345, contribution: 0 }, ctx),
    ).toMatchObject({ label: 'new_feature', display: '2.3' });
    expect(featureLabel('mean_56d')).toBe('Average sales, last 56 days');
    expect(featureLabel('something')).toBe('something');
  });

  it('maps day of year to month', () => {
    expect(monthOfDay(1)).toBe('January');
    expect(monthOfDay(32)).toBe('February');
    expect(monthOfDay(365)).toBe('December');
  });
});
