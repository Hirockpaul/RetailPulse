/** Report periods (V2 4c-1): UTC calendar days, pure. */
import type { ReportKind } from './reports.schemas';

/** 'YYYY-MM-DD' + n days. */
export function addDays(isoDay: string, n: number): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** DAILY: [end, end]; WEEKLY: the seven days ending on `end`. */
export function periodFor(kind: ReportKind, end: string): { start: string; end: string } {
  return { start: kind === 'DAILY' ? end : addDays(end, -6), end };
}

/** Monday = 1 … Sunday = 7, for a UTC day. */
export function isoWeekday(isoDay: string): number {
  const d = new Date(`${isoDay}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/**
 * The scheduled reports due once `yesterday` is complete: yesterday's DAILY, and — when today is a
 * Monday, i.e. yesterday was a Sunday — the WEEKLY report for Monday..Sunday.
 */
export function dueScheduled(
  yesterday: string,
): { kind: ReportKind; start: string; end: string }[] {
  const due: { kind: ReportKind; start: string; end: string }[] = [
    { kind: 'DAILY', ...periodFor('DAILY', yesterday) },
  ];
  if (isoWeekday(yesterday) === 7) due.push({ kind: 'WEEKLY', ...periodFor('WEEKLY', yesterday) });
  return due;
}
