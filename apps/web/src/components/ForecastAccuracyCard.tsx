import type { ForecastOverview, ModelMetric } from '../api/forecasts';
import { formatDateTime, formatInt, formatPercent } from '../lib/format';
import { Badge } from './Badge';
import { table } from './table';

const LABELS: Record<string, string> = {
  moving_average_28: 'Moving average (28 days)',
  seasonal_naive_7: 'Same weekday last week',
  hgb_direct: 'Machine learning (gradient boosting)',
};

/** How good the forecasts are, measured honestly on time-ordered holdout windows. */
export function ForecastAccuracyCard({ overview }: { overview: ForecastOverview }) {
  const run = overview.current;
  if (!run) return null;
  const byModel = new Map<string, Partial<Record<'validation' | 'test', ModelMetric>>>();
  for (const m of overview.metrics) {
    byModel.set(m.model, { ...byModel.get(m.model), [m.split]: m });
  }

  return (
    <section
      aria-labelledby="accuracy-heading"
      className="space-y-3 rounded-lg border bg-white p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="accuracy-heading" className="font-semibold">
          Forecast accuracy
        </h3>
        <div className="flex items-center gap-2 text-xs text-slate-500">
          {run.dataLabel === 'SYNTHETIC' && <Badge tone="warn" label="Synthetic data" />}
          <span>
            Generated {run.finishedAt ? formatDateTime(run.finishedAt) : '—'} · history up to{' '}
            {run.historyEnd ?? '—'}
          </span>
        </div>
      </div>

      <p className="text-sm">
        <strong>Used for recommendations:</strong>{' '}
        {LABELS[run.servedModel ?? ''] ?? run.servedModel}.{' '}
        <span className="text-slate-600">{run.selectionReason}</span>
      </p>

      <div className={table.wrap}>
        <table className={table.table}>
          <thead className={table.thead}>
            <tr>
              <th className={table.th}>Model</th>
              <th className={table.thNum}>Error, validation</th>
              <th className={table.thNum}>Error, test (untouched)</th>
              <th className={table.thNum}>Avg miss per day (units)</th>
            </tr>
          </thead>
          <tbody>
            {[...byModel.entries()].map(([model, m]) => (
              <tr key={model} className={table.row}>
                <td className={table.td}>
                  {LABELS[model] ?? model}{' '}
                  {model === run.servedModel && <Badge tone="good" label="in use" />}
                </td>
                <td className={table.tdNum}>{formatPercent(m.validation?.wape)}</td>
                <td className={table.tdNum}>{formatPercent(m.test?.wape)}</td>
                <td className={table.tdNum}>{m.test?.mae ? Number(m.test.mae).toFixed(2) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">
        Error = WAPE: total forecast miss ÷ total units sold (lower is better). The machine-learning
        model is used only if it beats the best simple method on <em>both</em> windows. Measured on{' '}
        {formatInt(overview.metrics[0]?.nSeries ?? 0)} products with enough history;{' '}
        {formatInt(run.fallbackCount ?? 0)} of {formatInt(run.seriesCount ?? 0)} products have too
        little history and use a category average instead.
      </p>
    </section>
  );
}
