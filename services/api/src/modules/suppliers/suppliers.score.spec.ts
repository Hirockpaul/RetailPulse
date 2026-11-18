import { type DeliveryStats, score } from './suppliers.score';

const stats = (over: Partial<DeliveryStats> = {}): DeliveryStats => ({
  deliveries: 20,
  meanLeadDays: 5,
  medianLeadDays: 5,
  stdLeadDays: 0,
  onTimeRate: 1,
  lateRate: 0,
  avgDaysLate: null,
  fillRate: 1,
  meanPromisedDays: 5,
  ...over,
});

describe('supplier reliability score', () => {
  it('is 100 for a perfect supplier', () => {
    expect(score(stats())).toMatchObject({ score: 100, enoughData: true });
    expect(score(stats()).summary).toMatch(/100 % on time \(never late\)/);
  });

  it('weights on-time 50, fill rate 30, lead-time steadiness 20 (hand-checked)', () => {
    // 50 × 0.8 + 30 × 0.9 + 20 × (1 − 2/5) = 40 + 27 + 12 = 79
    const s = score(
      stats({ onTimeRate: 0.8, lateRate: 0.2, avgDaysLate: 2.5, fillRate: 0.9, stdLeadDays: 2 }),
    );
    expect(s.score).toBe(79);
    expect(s.summary).toMatch(
      /80 % on time \(20 % late by 2\.5 days on average\); 90 % of ordered units/,
    );
  });

  it('caps the lead-time variation term at zero', () => {
    expect(score(stats({ stdLeadDays: 50 })).score).toBe(80); // 50 + 30 + 0
  });

  it('does not judge with fewer than 5 deliveries', () => {
    expect(score(stats({ deliveries: 4 }))).toMatchObject({ score: null, enoughData: false });
    expect(score(stats({ deliveries: 0, onTimeRate: null })).summary).toMatch(/too few to judge/);
  });
});
