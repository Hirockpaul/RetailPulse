import type { ForecastOverview, ModelMetric } from '../api/forecasts';
import { formatDateTime, formatInt, formatPercent, formatSignedPercent } from '../lib/format';
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
              <th className={table.thNum}>Bias, test</th>
              <th className={table.thNum}>80% range held, test</th>
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
                <td className={table.tdNum}>{formatSignedPercent(m.test?.bias)}</td>
                <td className={table.tdNum}>{formatPercent(m.test?.intervalCoverage)}</td>
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
        little history and use a category average instead. Bias: + means forecasts were too high on
        average, − too low.
      </p>
      <RangeReliability overview={overview} />
    </section>
  );
}

/** How well the ranges of the model in use held on the test window, per sales level. */
function RangeReliability({ overview }: { overview: ForecastOverview }) {
  const r80 = overview.ranges.filter((g) => g.level === 80 && g.testPoints > 0);
  if (r80.length === 0) return null;
  const r95 = (from: number) =>
    overview.ranges.find((g) => g.level === 95 && g.forecastFrom === from)?.testCoverage;
  const level = (g: { forecastFrom: number; forecastTo: number | null }) =>
    g.forecastTo === null ? `${g.forecastFrom}+` : `${g.forecastFrom}–${g.forecastTo}`;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer font-medium">
        How reliable are the forecast ranges? (by sales level)
      </summary>
      <div className={`${table.wrap} mt-2`}>
        <table className={table.table}>
          <thead className={table.thead}>
            <tr>
              <th className={table.th}>Forecast, units/day</th>
              <th className={table.thNum}>80% range held</th>
              <th className={table.thNum}>95% range held</th>
              <th className={table.thNum}>Days checked</th>
            </tr>
          </thead>
          <tbody>
            {r80.map((g) => (
              <tr key={g.forecastFrom} className={table.row}>
                <td className={table.td}>{level(g)}</td>
                <td className={table.tdNum}>{formatPercent(g.testCoverage)}</td>
                <td className={table.tdNum}>{formatPercent(r95(g.forecastFrom))}</td>
                <td className={table.tdNum}>{formatInt(g.testPoints)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-xs text-slate-500">
        Ranges are built from the model&apos;s real errors on earlier weeks and checked on the test
        weeks it had not seen. Close to 80% / 95% means the range can be trusted at that level. For
        very slow sellers sales are mostly 0 or 1, so a range can only be “0–1 unit” and holds more
        often than 80%.
      </p>
    </details>
  );
}
