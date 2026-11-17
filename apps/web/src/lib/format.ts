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
