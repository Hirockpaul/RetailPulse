import { fetchEventStats } from '../api/alerts';
import { Badge } from './Badge';
import { ErrorMessage, Loading } from './Status';
import { formatDateTime, formatInt } from '../lib/format';
import { useAsync } from '../lib/useAsync';

/** Event backlog and worker state, for admins and inventory managers. */
export function EventsCard() {
  const stats = useAsync(fetchEventStats);

  return (
    <section aria-labelledby="events-heading" className="rounded-xl border bg-card shadow-sm p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 id="events-heading" className="font-semibold">
          Event processing
        </h2>
        <button
          type="button"
          onClick={stats.reload}
          className="rounded border px-3 py-1 text-sm hover:bg-slate-100 focus:outline-2 focus:outline-sky-500"
        >
          Refresh
        </button>
      </div>
      {stats.status === 'loading' && <Loading />}
      {stats.status === 'error' && <ErrorMessage message={stats.error} onRetry={stats.reload} />}
      {stats.status === 'success' && (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-slate-500">Worker</dt>
          <dd className="flex items-center gap-2">
            <Badge
              ok={stats.data.worker.enabled}
              label={stats.data.worker.enabled ? 'running' : 'stopped'}
            />
            <span className="text-slate-500">polls every {stats.data.worker.pollMs} ms</span>
          </dd>
          <dt className="text-slate-500">Waiting</dt>
          <dd>
            {formatInt(stats.data.events.pending)}
            {stats.data.events.oldestPendingSeconds !== null &&
              ` (oldest ${stats.data.events.oldestPendingSeconds}s)`}
          </dd>
          <dt className="text-slate-500">Retrying</dt>
          <dd>{formatInt(stats.data.events.retrying)}</dd>
          <dt className="text-slate-500">Processed</dt>
          <dd>{formatInt(stats.data.events.processed)}</dd>
          <dt className="text-slate-500">Dead letters</dt>
          <dd className="flex items-center gap-2">
            {formatInt(stats.data.events.dead)}
            {stats.data.events.dead > 0 && <Badge tone="bad" label="needs attention" />}
          </dd>
          <dt className="text-slate-500">Last processed</dt>
          <dd>
            {stats.data.events.lastProcessedAt
              ? formatDateTime(stats.data.events.lastProcessedAt)
              : '—'}
          </dd>
        </dl>
      )}
    </section>
  );
}
