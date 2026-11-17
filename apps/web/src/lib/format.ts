const integer = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const money = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export const formatInt = (n: number) => integer.format(n);

/** API sends money as a decimal string ("4.99"); format for display only. */
export const formatMoney = (s: string) => money.format(Number(s));

/** Timestamps are stored in UTC and shown in the viewer's locale/time zone. */
export const formatDateTime = (iso: string) => dateTime.format(new Date(iso));

export const formatDelta = (n: number) => (n > 0 ? `+${formatInt(n)}` : formatInt(n));

export const humanize = (s: string) => s.toLowerCase().replace(/_/g, ' ');

/** A fraction as a percentage: 0.314 → "31.4%". */
export const formatPercent = (fraction: number | string | null | undefined) =>
  fraction === null || fraction === undefined ? '—' : `${(Number(fraction) * 100).toFixed(1)}%`;

/** One decimal place, for forecast quantities. */
export const formatDecimal = (n: number) => (Math.round(n * 10) / 10).toLocaleString();

/** "2026-11-17" → "17 Nov 2026" (dates are plain calendar days, no time zone). */
export const formatDay = (isoDay: string) =>
  new Date(`${isoDay}T00:00:00Z`).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
