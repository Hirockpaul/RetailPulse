import { frequentAdjustments, highReturnRate, largeWriteOff } from './anomalies.rules';

describe('largeWriteOff', () => {
  it('ignores receipts and small corrections', () => {
    expect(largeWriteOff(5, 40)).toBeNull();
    expect(largeWriteOff(-3, 40)).toBeNull(); // 3 of 43
    expect(largeWriteOff(-4, 4)).toBeNull(); // half of 8, but fewer than 10 were on hand
  });

  it('flags 20+ units, or half the stock when at least 10 were on hand', () => {
    expect(largeWriteOff(-20, 200)).toMatchObject({ severity: 'MEDIUM', observed: 20 });
    expect(largeWriteOff(-6, 6)).toMatchObject({
      severity: 'MEDIUM',
      details: { onHandBefore: 12, share: 0.5 },
    });
  });

  it('is HIGH for 50+ units or 80 %+ of the stock', () => {
    expect(largeWriteOff(-50, 500)?.severity).toBe('HIGH');
    expect(largeWriteOff(-9, 1)?.severity).toBe('HIGH'); // 90 % of 10
    expect(largeWriteOff(-35, 5)?.explanation).toMatch(/removed 35 units at once \(88 % of the 40/);
  });
});

describe('frequentAdjustments', () => {
  it('flags 3+ in the window and is HIGH from 5', () => {
    expect(frequentAdjustments(2)).toBeNull();
    expect(frequentAdjustments(3)).toMatchObject({ severity: 'MEDIUM', observed: 3 });
    expect(frequentAdjustments(5)?.severity).toBe('HIGH');
  });
});

describe('highReturnRate', () => {
  it('needs at least 5 returns and 25 % of sale lines', () => {
    expect(highReturnRate(4, 4)).toBeNull();
    expect(highReturnRate(5, 40)).toBeNull(); // 12.5 %
    expect(highReturnRate(5, 20)).toMatchObject({ severity: 'MEDIUM', score: 0.25, expected: 5 });
  });

  it('is HIGH from 50 % and copes with no sales at all', () => {
    expect(highReturnRate(6, 10)?.severity).toBe('HIGH');
    expect(highReturnRate(5, 0)).toMatchObject({ severity: 'HIGH', details: { saleLines: 0 } });
  });
});
