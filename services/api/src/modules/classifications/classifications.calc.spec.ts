import { classify, type ItemInput, variability, xyzOf } from './classifications.calc';

const steady = (perWeek: number, weeks = 52) => Array(weeks).fill(perWeek);
const item = (key: string, weekly: number[], unitCost = 1): ItemInput => ({
  key,
  weekly,
  unitCost,
});

describe('variability (XYZ inputs)', () => {
  it('steady demand has CV 0 and ADI 1', () => {
    expect(variability(steady(10))).toEqual({ mean: 10, cv: 0, adi: 1 });
  });

  it('alternating 0 and 20 has CV 1 and ADI 2 (sold every other week)', () => {
    const v = variability(Array.from({ length: 52 }, (_, i) => (i % 2 ? 20 : 0)));
    expect(v.mean).toBe(10);
    expect(v.cv).toBeCloseTo(1, 10);
    expect(v.adi).toBe(2);
  });

  it('nothing sold: no CV, no ADI', () => {
    expect(variability(steady(0))).toEqual({ mean: 0, cv: null, adi: null });
  });
});

describe('xyzOf', () => {
  it('uses the documented thresholds, inclusive at the top of X and Y', () => {
    expect(xyzOf(0.5, 1)).toBe('X');
    expect(xyzOf(0.51, 1)).toBe('Y');
    expect(xyzOf(1.0, 1)).toBe('Y');
    expect(xyzOf(1.01, 1)).toBe('Z');
  });

  it('intermittent demand or no sales is always Z', () => {
    expect(xyzOf(0.2, 1.33)).toBe('Z');
    expect(xyzOf(0.2, 1.32)).toBe('X');
    expect(xyzOf(null, null)).toBe('Z');
  });
});

describe('classify (ABC by value, XYZ by weekly variation)', () => {
  it('A = first 80 % of value (the item crossing the line is A), B up to 95 %, C the rest', () => {
    // Values 50, 30, 10, 6, 4 of a total 100.
    const out = classify([
      item('e', steady(4 / 52)),
      item('a', steady(50 / 52)),
      item('c', steady(10 / 52)),
      item('b', steady(30 / 52)),
      item('d', steady(6 / 52)),
    ]);
    expect(out.map((r) => [r.key, r.abc])).toEqual([
      ['a', 'A'], // before 0 %
      ['b', 'A'], // before 50 % → crosses 80 %
      ['c', 'B'], // before 80 %
      ['d', 'B'], // before 90 %
      ['e', 'C'], // before 96 %
    ]);
    expect(out[1].cumulativeShare).toBeCloseTo(0.8, 10);
    expect(out[4].cumulativeShare).toBeCloseTo(1, 10);
  });

  it('value is units × unit cost, so a cheap fast seller can rank below an expensive slow one', () => {
    const out = classify([item('cheap', steady(100), 0.1), item('dear', steady(2), 20)]);
    expect(out[0]).toMatchObject({ key: 'dear', value: 2 * 52 * 20, abc: 'A' });
    // 'cheap' starts exactly at 80 % of the value, so by the rule it is B (80-95 %).
    expect(out[1]).toMatchObject({ key: 'cheap', value: 100 * 52 * 0.1, abc: 'B' });
  });

  it('combines ABC and XYZ into the class, and items that sold nothing are CZ', () => {
    const out = classify([
      item('steady', steady(100)), // 5,200 of 5,460 = 95 % of the value → A, steady → X
      item(
        'erratic',
        Array.from({ length: 52 }, (_, i) => (i % 4 === 0 ? 20 : 0)),
      ), // starts at 95 % → C
      item('nothing', steady(0)),
    ]);
    const cls = Object.fromEntries(out.map((r) => [r.key, r.cls]));
    expect(cls).toEqual({ steady: 'AX', erratic: 'CZ', nothing: 'CZ' });
  });

  it('items with fewer than 13 weeks are NEW and do not count towards the value shares', () => {
    const out = classify([item('old', steady(10)), item('new', steady(1000, 12))]);
    expect(out.find((r) => r.key === 'new')).toMatchObject({ cls: 'NEW', abc: null, xyz: null });
    expect(out.find((r) => r.key === 'old')).toMatchObject({ cls: 'AX', valueShare: 1 });
  });
});
