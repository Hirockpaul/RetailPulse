/**
 * CSV export of a report (V2 4c-1): one row per number, RFC 4180 quoting, header row.
 *   section,metric,location,product,value
 */
import type { ReportContent } from './reports.schemas';

export const CSV_HEADER = ['section', 'metric', 'location', 'product', 'value'];

/** Quote a field when it contains a comma, quote, CR or LF; double inner quotes. */
export function csvField(v: string | number | null): string {
  const s = v === null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function reportRows(c: ReportContent): (string | number | null)[][] {
  const scope = c.scope?.code ?? 'NETWORK';
  const rows: (string | number | null)[][] = [
    ['report', 'kind', scope, null, c.kind],
    ['report', 'period_start', scope, null, c.periodStart],
    ['report', 'period_end', scope, null, c.periodEnd],
    ['report', 'generated_at', scope, null, c.generatedAt],
    ['report', 'data', scope, null, c.dataLabel],
    ['sales', 'units_sold', scope, null, c.sales.unitsSold],
    ['sales', 'units_returned', scope, null, c.sales.unitsReturned],
    ['sales', 'sales_value_at_price', scope, null, c.sales.salesValueAtPrice],
  ];
  for (const s of c.sales.byStore) {
    rows.push(['sales_by_store', 'units_sold', s.code, null, s.unitsSold]);
    rows.push(['sales_by_store', 'value_at_price', s.code, null, s.valueAtPrice]);
  }
  for (const p of c.sales.topProducts) {
    rows.push(['top_products', 'units_sold', scope, `${p.sku} ${p.name}`, p.unitsSold]);
  }
  for (const [k, v] of Object.entries(c.movements))
    rows.push(['movements', snake(k), scope, null, v]);
  for (const [k, v] of Object.entries(c.work)) rows.push(['work', snake(k), scope, null, v]);
  for (const [k, v] of Object.entries(c.stockAtGeneration)) {
    rows.push(['stock_at_generation', snake(k), scope, null, v]);
  }
  return rows;
}

const snake = (k: string) => k.replace(/[A-Z0-9]+/g, (m) => `_${m.toLowerCase()}`);

export function toCsv(c: ReportContent): string {
  return [CSV_HEADER, ...reportRows(c)].map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';
}

/** e.g. retailpulse-daily-STR-01-2026-11-17.csv */
export const csvFileName = (c: ReportContent) =>
  `retailpulse-${c.kind.toLowerCase()}-${c.scope?.code ?? 'network'}-${
    c.kind === 'DAILY' ? c.periodEnd : `${c.periodStart}_to_${c.periodEnd}`
  }.csv`;
