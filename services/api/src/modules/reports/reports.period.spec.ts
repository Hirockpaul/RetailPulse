import { addDays, dueScheduled, isoWeekday, periodFor } from './reports.period';

describe('report periods (V2 4c-1, UTC days)', () => {
  it('adds days across month and year ends', () => {
    expect(addDays('2026-11-17', 1)).toBe('2026-11-18');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29'); // leap year
  });

  it('a daily period is one day; a weekly period is the seven days ending on its end', () => {
    expect(periodFor('DAILY', '2026-11-17')).toEqual({ start: '2026-11-17', end: '2026-11-17' });
    expect(periodFor('WEEKLY', '2026-11-22')).toEqual({ start: '2026-11-16', end: '2026-11-22' });
  });

  it('knows the weekday (Monday = 1 … Sunday = 7)', () => {
    expect(isoWeekday('2026-11-16')).toBe(1); // a Monday
    expect(isoWeekday('2026-11-22')).toBe(7); // a Sunday
  });

  it('schedules yesterday daily, and last week only when yesterday was a Sunday', () => {
    expect(dueScheduled('2026-11-17')).toEqual([
      { kind: 'DAILY', start: '2026-11-17', end: '2026-11-17' },
    ]);
    expect(dueScheduled('2026-11-22')).toEqual([
      { kind: 'DAILY', start: '2026-11-22', end: '2026-11-22' },
      { kind: 'WEEKLY', start: '2026-11-16', end: '2026-11-22' },
    ]);
  });
});
