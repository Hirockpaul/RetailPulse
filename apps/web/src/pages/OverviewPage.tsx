import type { ReactNode } from 'react';
import { fetchOverview, type Overview, type PositionItem } from '../api/overview';
import { Badge } from '../components/Badge';
import { ControlTowerCharts, KpiRow, LocationTable, RiskPanel } from '../components/ControlTower';
import { AsOf, Empty, ErrorMessage, Loading } from '../components/Status';
import { table } from '../components/table';
import { useUser } from '../lib/auth';
import { formatDateTime, formatDay, formatDecimal, formatInt } from '../lib/format';
import { isStoreScoped } from '../lib/permissions';
import { href } from '../lib/router';
import { useAsync } from '../lib/useAsync';

/**
 * Landing page — the Control Tower (V2 4a): what needs attention, the key figures, risks with
 * links, charts, every location, and how fresh each number is.
 */
export function OverviewPage() {
  const user = useUser();
  const overview = useAsync(fetchOverview);

  return (
    <section aria-labelledby="overview-heading" className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="overview-heading" className="text-xl font-semibold">
            Control Tower
          </h2>
          <p className="text-sm text-slate-500">
            {isStoreScoped(user) ? 'Your stores' : 'All stores'}
            {overview.status === 'success' && ` · ${overview.data.storeCount} stores`}
          </p>
        </div>
        <button
          type="button"
          onClick={overview.reload}
          className="rounded border bg-white px-3 py-1 text-sm hover:bg-slate-100 focus:outline-2 focus:outline-sky-500"
        >
          Refresh
        </button>
      </div>

      {overview.status === 'loading' && <Loading />}
      {overview.status === 'error' && (
        <ErrorMessage message={overview.error} onRetry={overview.reload} />
      )}
      {overview.status === 'success' && <OverviewBody o={overview.data} />}
    </section>
  );
}

function OverviewBody({ o }: { o: Overview }) {
  const hasForecast = o.freshness.forecast !== null;
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          label="Out of stock now"
          value={o.stock.outOfStock}
          tone={o.stock.outOfStock > 0 ? 'bad' : 'good'}
          note={`of ${formatInt(o.stock.positions)} product × store positions`}
          to={href.alerts()}
        />
        <Tile
          label={`Runs out within ${o.rules.riskWindowDays} days`}
          value={hasForecast ? o.stock.atRisk : null}
          tone={o.stock.atRisk > 0 ? 'warn' : 'good'}
          note="available + inbound below forecast demand"
        />
        <Tile
          label="Pending recommendations"
          value={o.recommendations.pending}
          tone={o.recommendations.byRisk.CRITICAL > 0 ? 'bad' : 'neutral'}
          note={`${formatInt(o.recommendations.byRisk.CRITICAL)} critical · ${formatInt(
            o.recommendations.byAction.TRANSFER,
          )} transfers · ${formatInt(o.recommendations.byAction.PURCHASE_ORDER)} orders · ${formatInt(
            o.recommendations.byAction.REDISTRIBUTE_EXCESS,
          )} excess moves`}
          to={href.replenishment()}
        />
        <Tile
          label={`Excess (> ${o.rules.excessCoverDays} days of cover)`}
          value={hasForecast ? o.stock.excess : null}
          tone="neutral"
          note={hasForecast ? `${formatInt(o.stock.excessUnits)} surplus units` : ''}
        />
      </div>

      {!hasForecast && (
        <p className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          No forecast yet, so “runs out soon” and “excess” cannot be judged. An admin or inventory
          manager can start one under{' '}
          <a className={table.link} href={href.replenishment()}>
            Replenishment → Refresh forecasts
          </a>
          .
        </p>
      )}
      {hasForecast && o.stock.withoutForecast > 0 && (
        <p className="text-xs text-slate-500">
          {formatInt(o.stock.withoutForecast)} positions have no forecast and are not judged.
        </p>
      )}

      <KpiRow c={o.controlTower} />
      <RiskPanel o={o} />
      <ControlTowerCharts c={o.controlTower} />
      <LocationTable />

      {hasForecast && (
        <div className="grid gap-6 lg:grid-cols-2">
          <PositionTable
            title={`Soonest to run out (next ${o.rules.riskWindowDays} days)`}
            items={o.stock.atRiskTop}
            total={o.stock.atRisk}
            empty="Nothing is expected to run out in this window."
            extra={{
              label: `Demand ${o.rules.riskWindowDays}d`,
              value: (i) => formatDecimal(i.demandWindow),
            }}
          />
          <PositionTable
            title="Most surplus stock"
            items={o.stock.excessTop}
            total={o.stock.excess}
            empty="No position holds more than the cover limit."
            extra={{ label: 'Surplus', value: (i) => formatInt(i.excessUnits ?? 0) }}
          />
        </div>
      )}

      <Freshness o={o} />
    </>
  );
}

const TILE_TONES = {
  good: 'border-emerald-200',
  warn: 'border-amber-300',
  bad: 'border-red-300',
  neutral: 'border-slate-200',
};

function Tile(props: {
  label: string;
  value: number | null;
  tone: keyof typeof TILE_TONES;
  note: string;
  to?: string;
}) {
  const body = (
    <>
      <p className="text-sm text-slate-500">{props.label}</p>
      <p className="mt-1 text-3xl font-semibold tabular-nums">
        {props.value === null ? '—' : formatInt(props.value)}
      </p>
      <p className="mt-1 text-xs text-slate-500">
        {props.value === null ? 'needs a forecast' : props.note}
      </p>
    </>
  );
  const cls = `block rounded-xl border-2 bg-card shadow-sm p-4 ${TILE_TONES[props.tone]}`;
  return props.to ? (
    <a href={props.to} className={`${cls} hover:bg-slate-50 focus:outline-2 focus:outline-sky-500`}>
      {body}
    </a>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function PositionTable(props: {
  title: string;
  items: PositionItem[];
  total: number;
  empty: string;
  extra: { label: string; value: (i: PositionItem) => ReactNode };
}) {
  return (
    <div className="min-w-0 space-y-2">
      <h3 className="font-semibold">
        {props.title}{' '}
        {props.total > props.items.length && (
          <span className="text-sm font-normal text-slate-500">
            (top {props.items.length} of {formatInt(props.total)})
          </span>
        )}
      </h3>
      {props.items.length === 0 ? (
        <div className="rounded-xl border bg-card shadow-sm">
          <Empty>{props.empty}</Empty>
        </div>
      ) : (
        <div className={table.wrap}>
          <table className={table.table}>
            <thead className={table.thead}>
              <tr>
                <th className={table.th}>Product</th>
                <th className={table.th}>Store</th>
                <th className={table.thNum}>Available</th>
                <th className={table.thNum}>Inbound</th>
                <th className={table.thNum}>{props.extra.label}</th>
                <th className={table.thNum}>Days of cover</th>
              </tr>
            </thead>
            <tbody>
              {props.items.map((i) => (
                <tr key={`${i.productId}:${i.locationId}`} className={table.row}>
                  <td className={table.td}>
                    <a className={table.link} href={href.product(i.productId)}>
                      {i.sku}
                    </a>
                    <span className="block text-xs text-slate-500">{i.productName}</span>
                  </td>
                  <td className={table.td}>
                    <a className={table.link} href={href.stock(i.locationId)}>
                      {i.locationCode}
                    </a>
                  </td>
                  <td className={table.tdNum}>{formatInt(i.available)}</td>
                  <td className={table.tdNum}>{formatInt(i.inbound)}</td>
                  <td className={table.tdNum}>{props.extra.value(i)}</td>
                  <td className={table.tdNum}>
                    {i.daysOfCover === null ? 'no demand' : formatDecimal(i.daysOfCover)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Freshness({ o }: { o: Overview }) {
  const f = o.freshness;
  const when = (iso: string | null) => (iso ? formatDateTime(iso) : '—');
  return (
    <section
      aria-labelledby="freshness-heading"
      className="rounded-xl border bg-card shadow-sm p-5"
    >
      <h3 id="freshness-heading" className="mb-3 font-semibold">
        How fresh is this?
      </h3>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-[max-content_1fr] sm:gap-y-2">
        <dt className="text-slate-500">Stock numbers</dt>
        <dd>
          <AsOf iso={o.asOf} />
        </dd>
        <dt className="text-slate-500">Last stock movement</dt>
        <dd>{when(f.lastMovementAt)}</dd>
        <dt className="text-slate-500">Forecast</dt>
        <dd className="flex flex-wrap items-center gap-2">
          {f.forecast ? (
            <>
              <span>
                run {when(f.forecast.finishedAt)}, history up to{' '}
                {f.forecast.historyEnd ? formatDay(f.forecast.historyEnd) : '—'}, model{' '}
                {f.forecast.servedModel ?? '—'}
              </span>
              {f.forecast.dataLabel && <Badge tone="warn" label={`${f.forecast.dataLabel} data`} />}
            </>
          ) : (
            'none yet'
          )}
        </dd>
        <dt className="text-slate-500">Recommendations generated</dt>
        <dd>{when(o.recommendations.lastGeneratedAt)}</dd>
        <dt className="text-slate-500">Alerts</dt>
        <dd>
          {formatInt(o.alerts.open)} open ({formatInt(o.alerts.byKind.OUT_OF_STOCK)} out,{' '}
          {formatInt(o.alerts.byKind.LOW_STOCK)} low) · up to date as of the last processed event (
          {when(f.lastEventProcessedAt)})
          {f.eventsWaiting > 0 && ` · ${formatInt(f.eventsWaiting)} events still waiting`}
        </dd>
      </dl>
    </section>
  );
}
