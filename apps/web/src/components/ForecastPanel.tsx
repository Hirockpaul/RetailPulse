import { type ReactNode, useCallback, useState } from 'react';
import { fetchSeriesForecast, rangeGroupFor, type SeriesForecast } from '../api/forecasts';
import { listLocations } from '../api/locations';
import { useUser } from '../lib/auth';
import { formatDateTime, formatDay, formatDecimal, formatPercent } from '../lib/format';
import { canAccessLocation } from '../lib/permissions';
import { useAsync } from '../lib/useAsync';
import { Badge } from './Badge';
import { ForecastChart } from './ForecastChart';
import { ForecastExplanation } from './ForecastExplanation';
import { Empty, ErrorMessage, Loading } from './Status';
import { field } from './table';

/** Demand forecast for one product at one store: history, forecast, range, accuracy. */
export function ForecastPanel({ productId }: { productId: string }) {
  const user = useUser();
  const locations = useAsync(listLocations);
  const stores = (locations.status === 'success' ? locations.data.data : []).filter(
    (l) => l.type === 'STORE' && canAccessLocation(user, l.id),
  );
  const [chosen, setChosen] = useState('');
  const locationId = stores.find((l) => l.id === chosen)?.id ?? stores[0]?.id;

  return (
    <section aria-labelledby="forecast-heading" className="space-y-2">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h3 id="forecast-heading" className="font-semibold">
          Demand forecast
        </h3>
        <label className="flex flex-col text-xs text-slate-500">
          Store
          <select
            className={field}
            value={locationId ?? ''}
            onChange={(e) => setChosen(e.target.value)}
          >
            {stores.map((l) => (
              <option key={l.id} value={l.id}>
                {l.code} — {l.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {locations.status === 'loading' && <Loading />}
      {locations.status === 'error' && (
        <ErrorMessage message={locations.error} onRetry={locations.reload} />
      )}
      {locationId && (
        <StoreForecast key={locationId} productId={productId} locationId={locationId} />
      )}
    </section>
  );
}

function StoreForecast({ productId, locationId }: { productId: string; locationId: string }) {
  const forecast = useAsync(
    useCallback(() => fetchSeriesForecast(productId, locationId), [productId, locationId]),
  );

  if (forecast.status === 'loading') return <Loading />;
  if (forecast.status === 'error') {
    return forecast.httpStatus === 404 ? (
      <Empty>
        No forecast for this product at this store yet. An admin or inventory manager can run one
        from the Replenishment page.
      </Empty>
    ) : (
      <ErrorMessage message={forecast.error} onRetry={forecast.reload} />
    );
  }

  const f = forecast.data;
  return (
    <div className="space-y-3 rounded-xl border bg-card shadow-sm p-4">
      <ForecastChart history={f.history} points={f.points} />
      <RangeExplanation f={f} />
      <ForecastExplanation productId={productId} locationId={locationId} />
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        <Fact label="Model">
          {f.model} {f.isFallback && <Badge tone="warn" label="fallback" />}
        </Fact>
        <Fact label="Average per day (last 28 d)">{formatDecimal(f.avgDaily28)}</Fact>
        <Fact label="History used">{f.historyDays} days</Fact>
        <Fact label="Accuracy on the test window (WAPE)">
          {f.testWape === null ? 'not measured (too little history)' : formatPercent(f.testWape)}
        </Fact>
      </dl>
      <p className="text-xs text-slate-500">
        {f.run.dataLabel === 'SYNTHETIC' && <Badge tone="warn" label="Synthetic data" />} Forecast
        generated {f.run.finishedAt ? formatDateTime(f.run.finishedAt) : '—'} from history up to{' '}
        {f.run.historyEnd ?? '—'}. A forecast is advice; it never orders or moves stock by itself.
      </p>
    </div>
  );
}

/**
 * The range in words, with how often ranges like it held on the untouched test window. The
 * daily ranges are not added up: a range for the 14-day total would need its own calculation.
 */
function RangeExplanation({ f }: { f: SeriesForecast }) {
  if (f.points.length === 0) return null;
  const total = f.points.reduce((n, p) => n + p.yhat, 0);
  const perDay = total / f.points.length;
  const first = f.points[0];
  const group80 = rangeGroupFor(f.ranges, 80, perDay);
  const group95 = rangeGroupFor(f.ranges, 95, perDay);
  return (
    <div className="rounded border border-sky-100 bg-sky-50 px-3 py-2 text-sm text-slate-700">
      <p>
        Expected: about <strong>{formatDecimal(total)} units</strong> over the next{' '}
        {f.points.length} days ({formatDecimal(perDay)} per day). First day, {formatDay(first.day)}:{' '}
        {formatDecimal(first.yhat)} units, with an 80% range of {formatDecimal(first.lower)}–
        {formatDecimal(first.upper)}
        {first.lower95 != null && first.upper95 != null && (
          <>
            {' '}
            and a 95% range of {formatDecimal(first.lower95)}–{formatDecimal(first.upper95)}
          </>
        )}
        .
      </p>
      <p className="mt-1 text-xs text-slate-600">
        {group80?.testCoverage != null ? (
          <>
            How reliable: for forecasts of this size, the 80% range held on{' '}
            <strong>{formatPercent(group80.testCoverage)}</strong> of days in the test period
            {group95?.testCoverage != null && (
              <> (95% range: {formatPercent(group95.testCoverage)})</>
            )}
            , measured on {group80.testPoints.toLocaleString()} days the model had not seen.
          </>
        ) : (
          <>
            The reliability of this range has not been measured (run made before ranges were
            checked).
          </>
        )}{' '}
        Ranges come from the model&apos;s real past errors; they are a guide, not a guarantee, and
        the daily ranges cannot simply be added up for the total.
      </p>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}
