import { useState } from 'react';
import { ApiError } from '../api/client';
import {
  getMonitoring,
  type HealthLevel,
  type MonitoringResult,
  type MonitoringRun,
  runMonitoring,
} from '../api/ml';
import { Badge } from '../components/Badge';
import { Empty, ErrorMessage, Loading } from '../components/Status';
import { table } from '../components/table';
import { useUser } from '../lib/auth';
import { formatDateTime, formatDay, formatInt, formatPercent } from '../lib/format';
import { canApprove } from '../lib/permissions';
import { href } from '../lib/router';
import { useAsync } from '../lib/useAsync';

type Tone = 'good' | 'warn' | 'bad' | 'neutral';

const STATUS_TONE: Record<string, Tone> = {
  OK: 'good',
  STABLE: 'good',
  WATCH: 'warn',
  WARN: 'warn',
  DRIFT: 'bad',
  DEGRADED: 'bad',
  ALERT: 'bad',
  FAILED: 'bad',
  SUCCEEDED: 'good',
  INSUFFICIENT_DATA: 'neutral',
};

const LABEL: Record<string, string> = {
  INSUFFICIENT_DATA: 'Not enough data',
  STABLE: 'Stable',
  WATCH: 'Watch',
  DRIFT: 'Drift',
  OK: 'OK',
  DEGRADED: 'Degraded',
  WARN: 'Warning',
  ALERT: 'Alert',
  FAILED: 'Failed',
  SUCCEEDED: 'Succeeded',
};

const HEALTH_TITLE: Record<string, string> = {
  FRESHNESS: 'Forecast freshness',
  LATEST_RUN: 'Latest forecast run',
  MONITORING: 'Monitoring',
  MODEL_QUALITY: 'Model quality',
};

const FEATURE_TEXT: Record<string, string> = {
  mean_7d: 'Average sales, last 7 days',
  mean_28d: 'Average sales, last 28 days',
  mean_56d: 'Average sales, last 56 days',
  std_28d: 'Day-to-day spread, last 28 days',
  last_same_weekday: 'Sales on the same weekday last week',
  ratio_7d_28d: 'Recent trend (7 ÷ 28-day average)',
};

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <span className="text-slate-500">—</span>;
  return <Badge tone={STATUS_TONE[status] ?? 'neutral'} label={LABEL[status] ?? status} />;
}

const num = (x: number | null, digits = 3) => (x === null ? '—' : x.toFixed(digits));
const count = (x: number | null) => (x === null ? '—' : formatInt(x));

function windowsText(m: MonitoringRun): string {
  const reference =
    m.referenceStart && m.referenceEnd
      ? `${formatDay(m.referenceStart)} – ${formatDay(m.referenceEnd)}`
      : 'none';
  const current =
    m.currentStart && m.currentEnd
      ? `${formatDay(m.currentStart)} – ${formatDay(m.currentEnd)} (${m.currentDays} days)`
      : 'no complete day after training yet';
  return `Model ${m.modelName ?? '—'}, trained through ${m.trainingEnd ? formatDay(m.trainingEnd) : '—'}. Reference: ${reference}. New data: ${current}.`;
}

function DriftTable({
  title,
  caption,
  rows,
  label,
}: {
  title: string;
  caption: string;
  rows: MonitoringResult[];
  label: (r: MonitoringResult) => string;
}) {
  if (rows.length === 0) return null;
  return (
    <section className="space-y-2">
      <h4 className="font-medium">{title}</h4>
      <p className="text-xs text-slate-500">{caption}</p>
      <div className={table.wrap}>
        <table className={table.table}>
          <thead className={table.thead}>
            <tr>
              <th className={table.th}>Checked</th>
              <th className={table.th}>Status</th>
              <th className={table.thNum}>PSI</th>
              <th className={table.thNum}>KS D</th>
              <th className={table.thNum}>Reference n</th>
              <th className={table.thNum}>New n</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.checkKind}-${r.subject}`} className={table.row}>
                <td className={table.td}>{label(r)}</td>
                <td className={table.td}>
                  <StatusBadge status={r.status} />
                </td>
                <td className={table.tdNum}>{num(r.psi)}</td>
                <td className={table.tdNum}>{num(r.ksD)}</td>
                <td className={table.tdNum}>{count(r.nReference)}</td>
                <td className={table.tdNum}>{count(r.nCurrent)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Model monitoring (V2 3c-2): run health, drift and accuracy on new days. Describes only. */
export function MonitoringPage() {
  const user = useUser();
  const data = useAsync(getMonitoring);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await runMonitoring();
      data.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unexpected error.');
    } finally {
      setBusy(false);
    }
  };

  const latest = data.status === 'success' ? data.data.latest : null;
  const of = (kind: MonitoringResult['checkKind']) =>
    latest?.results.filter((r) => r.checkKind === kind) ?? [];
  const perf = of('PERFORMANCE')[0];

  return (
    <section aria-labelledby="monitoring-heading" className="space-y-5">
      <a className={table.link} href={href.models()}>
        ← Model registry
      </a>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 id="monitoring-heading" className="text-xl font-semibold">
            Model monitoring
          </h2>
          <p className="max-w-3xl text-sm text-slate-600">
            Has the world moved since the active model learned, and is it still as accurate as
            measured? Monitoring only describes: it never retrains, activates or rolls back a model.
            All data here is synthetic.
          </p>
        </div>
        {canApprove(user) && (
          <button
            type="button"
            onClick={run}
            disabled={busy}
            className="rounded bg-slate-900 px-4 py-1.5 text-sm text-white enabled:hover:bg-slate-700 disabled:opacity-50 focus:outline-2 focus:outline-sky-500"
          >
            {busy ? 'Running…' : 'Run monitoring now'}
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      {data.status === 'loading' && <Loading />}
      {data.status === 'error' && <ErrorMessage message={data.error} onRetry={data.reload} />}
      {data.status === 'success' && (
        <>
          <section
            aria-labelledby="health-heading"
            className="space-y-3 rounded-lg border bg-white p-5"
          >
            <div className="flex items-center gap-2">
              <h3 id="health-heading" className="font-semibold">
                Run health
              </h3>
              <StatusBadge status={data.data.health.overall as HealthLevel} />
            </div>
            <ul className="space-y-2 text-sm">
              {data.data.health.checks.map((c) => (
                <li key={c.key} className="flex flex-wrap items-baseline gap-2">
                  <StatusBadge status={c.level} />
                  <span className="font-medium">{HEALTH_TITLE[c.key]}:</span>
                  <span className="text-slate-700">{c.message}</span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-slate-500">
              Checked now from the latest runs; nothing is started or retried automatically.
            </p>
          </section>

          {!latest && <Empty>Monitoring has not produced a result yet.</Empty>}
          {latest && (
            <section
              aria-labelledby="latest-heading"
              className="space-y-4 rounded-lg border bg-white p-5"
            >
              <div className="space-y-1">
                <h3 id="latest-heading" className="font-semibold">
                  Latest result
                </h3>
                <p className="text-sm text-slate-600">
                  {formatDateTime(latest.createdAt)} ·{' '}
                  {latest.trigger === 'MANUAL' ? 'run by hand' : 'after a forecast run'}.{' '}
                  {windowsText(latest)}
                </p>
              </div>
              <dl className="grid gap-3 text-sm sm:grid-cols-3">
                {(
                  [
                    ['Data drift', latest.dataDrift],
                    ['Forecast drift', latest.predictionDrift],
                    ['Accuracy on new days', latest.performance],
                  ] as const
                ).map(([label, status]) => (
                  <div key={label} className="rounded border p-3">
                    <dt className="text-slate-500">{label}</dt>
                    <dd className="mt-1">
                      <StatusBadge status={status} />
                    </dd>
                  </div>
                ))}
              </dl>
              {latest.currentDays < data.data.rules.minCurrentDays && (
                <p className="rounded border border-slate-300 bg-slate-50 p-2 text-sm text-slate-700">
                  Only {latest.currentDays} complete day{latest.currentDays === 1 ? '' : 's'} since
                  the model was trained; {data.data.rules.minCurrentDays} are needed before drift
                  can be judged. “Not enough data” is not a sign of health.
                </p>
              )}

              {perf && (
                <section className="space-y-1">
                  <h4 className="font-medium">Accuracy on days that now have sales</h4>
                  <p className="text-sm text-slate-700">
                    <StatusBadge status={perf.status} />{' '}
                    {perf.wape === null
                      ? 'No kept forecast has a day with sales yet.'
                      : `Realized error (WAPE) ${formatPercent(perf.wape)} vs ${perf.backtestWape === null ? '—' : formatPercent(perf.backtestWape)} in the backtest; bias ${formatPercent(perf.bias)}; ${count(perf.nPoints)} forecasts over ${count(perf.nDays)} day${perf.nDays === 1 ? '' : 's'}.`}
                  </p>
                </section>
              )}

              <DriftTable
                title="Model inputs"
                caption="The demand inputs the model sees, pooled over all products and stores."
                rows={of('FEATURE')}
                label={(r) => FEATURE_TEXT[r.subject] ?? r.subject}
              />
              <DriftTable
                title="Daily sales per store"
                caption="Checked per store, because a change at one store hardly shows in pooled inputs."
                rows={of('STORE_SALES')}
                label={(r) => r.subject}
              />
              <DriftTable
                title="The model's forecasts"
                caption="Day-1 forecasts of the active model on reference days vs new days."
                rows={of('PREDICTION')}
                label={(r) => r.subject}
              />
            </section>
          )}

          <section aria-labelledby="recent-heading" className="space-y-2">
            <h3 id="recent-heading" className="font-semibold">
              Recent monitoring runs
            </h3>
            {data.data.recent.length === 0 ? (
              <Empty>None yet.</Empty>
            ) : (
              <div className={table.wrap}>
                <table className={table.table}>
                  <thead className={table.thead}>
                    <tr>
                      <th className={table.th}>When</th>
                      <th className={table.th}>Trigger</th>
                      <th className={table.th}>Run</th>
                      <th className={table.th}>Data</th>
                      <th className={table.th}>Forecasts</th>
                      <th className={table.th}>Accuracy</th>
                      <th className={table.thNum}>New days</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.data.recent.map((m) => (
                      <tr key={m.id} className={table.row}>
                        <td className={table.td}>{formatDateTime(m.createdAt)}</td>
                        <td className={table.td}>
                          {m.trigger === 'MANUAL' ? 'By hand' : 'Forecast run'}
                        </td>
                        <td className={table.td} title={m.error ?? undefined}>
                          <StatusBadge status={m.status} />
                        </td>
                        <td className={table.td}>
                          <StatusBadge status={m.dataDrift} />
                        </td>
                        <td className={table.td}>
                          <StatusBadge status={m.predictionDrift} />
                        </td>
                        <td className={table.td}>
                          <StatusBadge status={m.performance} />
                        </td>
                        <td className={table.tdNum}>{m.currentDays}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="space-y-1 text-xs text-slate-500">
            <h3 className="text-sm font-semibold text-slate-700">How to read this</h3>
            <ul className="list-disc space-y-1 pl-5">
              {data.data.rules.text.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </section>
        </>
      )}
    </section>
  );
}
