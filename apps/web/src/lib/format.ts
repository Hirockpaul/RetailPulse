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

/** A signed fraction as a percentage: 0.012 → "+1.2%", -0.03 → "−3.0%". */
export const formatSignedPercent = (fraction: number | string | null | undefined) => {
  if (fraction === null || fraction === undefined) return '—';
  const v = Number(fraction) * 100;
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}%`;
};

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

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
/** Stat-tile values: 1,284 / 12.9K / 4.2M (full under 10,000). */
export const formatCompact = (n: number) =>
  Math.abs(n) < 10_000 ? formatInt(n) : compact.format(n);
