import { SEVERITY, stockState } from './alerts.schemas';

describe('stockState (the low-stock rule)', () => {
  it.each([
    [0, 12, 'OUT_OF_STOCK'],
    [-3, 12, 'OUT_OF_STOCK'],
    [1, 12, 'LOW_STOCK'],
    [11, 12, 'LOW_STOCK'],
    [12, 12, 'OK'],
    [40, 12, 'OK'],
    [1, 1, 'OK'],
    [0, 1, 'OUT_OF_STOCK'],
  ])('available %i with pack size %i → %s', (available, pack, expected) => {
    expect(stockState(available, pack)).toBe(expected);
  });

  it('out of stock is more severe than low', () => {
    expect(SEVERITY.OUT_OF_STOCK).toBe('HIGH');
    expect(SEVERITY.LOW_STOCK).toBe('MEDIUM');
  });
});
