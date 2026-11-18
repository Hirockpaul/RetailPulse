import { useCallback } from 'react';
import { type ControlTower, fetchLocationHealth, type Overview } from '../api/overview';
import { formatCompact, formatDay, formatInt, formatPercent } from '../lib/format';
import { href } from '../lib/router';
import { useAsync } from '../lib/useAsync';
import { ChartCard } from './charts/ChartCard';
import { HBarChart } from './charts/HBarChart';
import { SalesLineChart } from './charts/SalesLineChart';
import { type Segment, SegmentedBars } from './charts/SegmentedBars';
import { CHART } from './charts/theme';
import { ErrorMessage, Loading } from './Status';
import { table } from './table';

const money = (n: number) =>
  n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Stock and work KPIs (V2 4a-2): plain stat tiles, values auto-compacted. */
export function KpiRow({ c }: { c: ControlTower }) {
  const k = c.kpis;
  const tiles: [string, string, string][] = [
    ['Units on hand', formatCompact(k.onHand), 'all locations in your scope'],
    ['Units available', formatCompact(k.available), 'on hand minus reserved'],
    ['Stock value at cost', formatCompact(k.valueAtCost), 'units × primary supplier cost'],
    ['Open transfers', formatInt(k.openTransfers), 'requested, approved or on the way'],
    ['Open anomalies', formatInt(k.openAnomalies), 'new or being investigated'],
    ['Excess value at cost', formatCompact(k.excessValueAtCost), 'stock beyond 60 days of cover'],
  ];
  return (
    <section
      aria-label="Key figures"
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6"
    >
      {tiles.map(([label, value, note]) => (
        <div key={label} className="rounded-lg border bg-white p-3">
          <p className="text-xs text-slate-500">{label}</p>
          <p className="mt-1 text-xl font-semibold">{value}</p>
          <p className="mt-0.5 text-xs text-slate-500">{note}</p>
        </div>
      ))}
    </section>
  );
}

/** Each risk: a count, what it means, and where to act on it. Zero is shown, never hidden. */
export function RiskPanel({ o }: { o: Overview }) {
  const c = o.controlTower;
  const r = c.risks;
  const hasForecast = o.freshness.forecast !== null;
  const items: { label: string; value: string; meaning: string; to: string; link: string }[] = [
    {
      label: `At risk within ${o.rules.riskWindowDays} days`,
      value: hasForecast ? formatInt(r.atRisk7) : '—',
      meaning: 'available + inbound will not cover forecast demand',
      to: href.replenishment(),
      link: 'Replenishment',
    },
    {
      label: `At risk within ${c.rules.riskWindowLongDays} days`,
      value: hasForecast ? formatInt(r.atRisk14) : '—',
      meaning: 'the same test over a longer window',
      to: href.replenishment(),
      link: 'Replenishment',
    },
    {
      label: 'Excess stock',
      value: hasForecast ? formatInt(r.excess.positions) : '—',
      meaning: `${formatInt(r.excess.units)} units, ${money(r.excess.valueAtCost)} at cost`,
      to: href.replenishment(),
      link: 'Excess moves',
    },
    {
      label: 'Delayed transfers',
      value: formatInt(r.delayedTransfers),
      meaning: `approved or dispatched more than ${c.rules.transferDelayDays} days ago`,
      to: href.transfers(),
      link: 'Transfers',
    },
    {
      label: 'Overdue purchase orders',
      value: formatInt(r.overduePurchaseOrders),
      meaning: 'approved, expected date has passed',
      to: href.purchaseOrders(),
      link: 'Purchase orders',
    },
    {
      label: 'Open anomalies',
      value: formatInt(r.openAnomalies),
      meaning: `${formatInt(r.openHighAnomalies)} high severity`,
      to: href.anomalies(),
      link: 'Unusual activity',
    },
    {
      label: 'Suppliers at risk',
      value: formatInt(r.suppliersAtRisk.length),
      meaning:
        r.suppliersAtRisk.length === 0
          ? `every supplier scores ${c.rules.supplierRiskScore} or more`
          : r.suppliersAtRisk
              .map(
                (s) =>
                  `${s.name} (score ${Math.round(s.score ?? 0)}, ${s.openPurchaseOrders} open orders)`,
              )
              .join('; '),
      to: href.suppliers(),
      link: 'Suppliers',
    },
  ];
  return (
    <section aria-labelledby="risk-heading" className="space-y-2 rounded-lg border bg-white p-4">
      <h3 id="risk-heading" className="font-semibold">
        Risks
      </h3>
      <ul className="divide-y text-sm">
        {items.map((i) => (
          <li key={i.label} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2">
            <span className="w-12 shrink-0 text-right text-lg font-semibold">{i.value}</span>
            <span className="min-w-0 flex-1">
              <span className="font-medium">{i.label}</span>{' '}
              <span className="text-slate-500">— {i.meaning}</span>
            </span>
            <a className={`${table.link} text-xs`} href={i.to}>
              {i.link} →
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

const STATES: Segment[] = [
  { key: 'outOfStock', label: 'Out of stock', color: CHART.state.outOfStock },
  { key: 'atRisk', label: 'At risk (7 days)', color: CHART.state.atRisk },
  { key: 'healthy', label: 'Healthy', color: CHART.state.healthy },
  { key: 'excess', label: 'Excess', color: CHART.state.excess },
  { key: 'noForecast', label: 'No forecast', color: CHART.state.noForecast },
];

/** The four Control Tower charts. */
export function ControlTowerCharts({ c }: { c: ControlTower }) {
  const health = c.charts.storeHealth;
  const showNoForecast = health.some((h) => h.noForecast > 0);
  const states = STATES.filter((s) => s.key !== 'noForecast' || showNoForecast);
  const sales = c.charts.sales;
  return (
    <section aria-label="Charts" className="grid gap-4 lg:grid-cols-2">
      <ChartCard
        title="Stock health by store"
        subtitle="Products at each store, by state"
        legend={states.map((s) => ({ label: s.label, color: s.color, kind: 'rect' }))}
        tableHead={['Store', ...states.map((s) => s.label)]}
        tableRows={health.map((h) => [
          h.locationCode,
          ...states.map((s) => h[s.key as keyof typeof h] as number),
        ])}
        numeric={states.map((_, i) => i + 1)}
      >
        {health.length === 0 ? (
          <p className="text-sm text-slate-500">No store stock in your scope.</p>
        ) : (
          <SegmentedBars
            rows={health.map((h) => ({
              id: h.locationId,
              label: h.locationCode,
              values: h as unknown as Record<string, number>,
            }))}
            segments={states}
            describe={(row, s, v, share) =>
              `${row.label} · ${s.label}: ${formatInt(v)} products (${formatPercent(share)})`
            }
          />
        )}
      </ChartCard>

      <ChartCard
        title="Units sold and forecast"
        subtitle={`All stores in your scope: last ${sales.history.length} days sold, next ${sales.forecast.length} days forecast`}
        legend={[
          { label: 'Units sold per day', color: CHART.series1, kind: 'line' },
          { label: 'Forecast per day', color: CHART.series2, kind: 'line' },
        ]}
        tableHead={['Day', 'Sold', 'Forecast']}
        tableRows={[
          ...sales.history.map((d) => [formatDay(d.day), formatInt(d.units), '—']),
          ...sales.forecast.map((d) => [formatDay(d.day), '—', formatInt(Math.round(d.units))]),
        ]}
        numeric={[1, 2]}
      >
        {sales.history.length + sales.forecast.length < 2 ? (
          <p className="text-sm text-slate-500">Appears after the first forecast run.</p>
        ) : (
          <SalesLineChart history={sales.history} forecast={sales.forecast} />
        )}
      </ChartCard>

      <ChartCard
        title="Excess value at cost by store"
        subtitle="Stock beyond 60 days of forecast demand, at primary supplier cost"
        tableHead={['Store', 'Excess units', 'Value at cost']}
        tableRows={health.map((h) => [
          h.locationCode,
          formatInt(h.excessUnits),
          money(h.excessValue),
        ])}
        numeric={[1, 2]}
      >
        <HBarChart
          bars={health.map((h) => ({
            id: h.locationId,
            label: h.locationCode,
            value: h.excessValue,
            valueText: money(h.excessValue),
          }))}
        />
      </ChartCard>

      <ChartCard
        title="Supplier on-time rate"
        subtitle={`Share of deliveries on time; suppliers scoring below ${c.rules.supplierRiskScore} are a supply risk`}
        tableHead={['Supplier', 'On time', 'Score', 'Open orders']}
        tableRows={c.charts.suppliers.map((s) => [
          s.name,
          s.onTimeRate === null ? '—' : formatPercent(s.onTimeRate),
          s.score === null ? '—' : Math.round(s.score),
          s.openPurchaseOrders,
        ])}
        numeric={[1, 2, 3]}
      >
        <HBarChart
          max={1}
          labelWidth="w-28 sm:w-36"
          bars={c.charts.suppliers.map((s) => ({
            id: s.id,
            label: s.name.replace(' (synthetic)', ''),
            value: s.onTimeRate ?? 0,
            valueText: s.onTimeRate === null ? 'no data' : formatPercent(s.onTimeRate),
            note:
              s.score !== null && s.score < c.rules.supplierRiskScore
                ? `score ${Math.round(s.score)} — below ${c.rules.supplierRiskScore}`
                : s.score === null
                  ? 'too few deliveries'
                  : `score ${Math.round(s.score)}`,
          }))}
        />
      </ChartCard>
    </section>
  );
}

/** Per-location health (GET /overview/locations). */
export function LocationTable() {
  const rows = useAsync(useCallback(() => fetchLocationHealth(), []));
  const dash = (n: number | null) => (n === null ? '—' : formatInt(n));
  return (
    <section aria-labelledby="locations-heading" className="space-y-2">
      <h3 id="locations-heading" className="font-semibold">
        Locations
      </h3>
      {rows.status === 'loading' && <Loading />}
      {rows.status === 'error' && <ErrorMessage message={rows.error} onRetry={rows.reload} />}
      {rows.status === 'success' && (
        <div className={table.wrap}>
          <table className={table.table}>
            <thead className={table.thead}>
              <tr>
                <th className={table.th}>Location</th>
                <th className={table.thNum}>On hand</th>
                <th className={table.thNum}>Value at cost</th>
                <th className={table.thNum}>Out of stock</th>
                <th className={table.thNum}>At risk</th>
                <th className={table.thNum}>Excess</th>
                <th className={table.thNum}>Pending recs</th>
                <th className={table.thNum}>Alerts</th>
                <th className={table.thNum}>Anomalies</th>
                <th className={table.thNum}>Transfers in / out</th>
              </tr>
            </thead>
            <tbody>
              {rows.data.map((r) => (
                <tr key={r.locationId} className={table.row}>
                  <td className={table.td}>
                    <a className={table.link} href={href.stock(r.locationId)}>
                      {r.locationCode}
                    </a>{' '}
                    <span className="text-slate-500">
                      {r.locationType === 'STORE' ? r.locationName : 'Distribution centre'}
                    </span>
                  </td>
                  <td className={table.tdNum}>{formatInt(r.onHand)}</td>
                  <td className={table.tdNum}>{money(r.valueAtCost)}</td>
                  <td className={table.tdNum}>{dash(r.outOfStock)}</td>
                  <td className={table.tdNum}>{dash(r.atRisk)}</td>
                  <td className={table.tdNum}>{dash(r.excess)}</td>
                  <td className={table.tdNum}>{formatInt(r.pendingRecommendations)}</td>
                  <td className={table.tdNum}>{formatInt(r.openAlerts)}</td>
                  <td className={table.tdNum}>{formatInt(r.openAnomalies)}</td>
                  <td className={table.tdNum}>
                    {formatInt(r.transfersIn)} / {formatInt(r.transfersOut)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-slate-500">
        Distribution centres have no forecast, so stock-health columns show “—” for them.
      </p>
    </section>
  );
}
