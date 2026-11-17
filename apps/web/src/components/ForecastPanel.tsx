import { type ReactNode, useCallback, useState } from 'react';
import { fetchSeriesForecast } from '../api/forecasts';
import { listLocations } from '../api/locations';
import { useUser } from '../lib/auth';
import { formatDateTime, formatDecimal, formatPercent } from '../lib/format';
import { canAccessLocation } from '../lib/permissions';
import { useAsync } from '../lib/useAsync';
import { Badge } from './Badge';
import { ForecastChart } from './ForecastChart';
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
    <div className="space-y-3 rounded-lg border bg-white p-4">
      <ForecastChart history={f.history} points={f.points} />
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

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}
