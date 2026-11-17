import { fetchHealth } from '../api/health';
import { Badge } from '../components/Badge';
import { EventsCard } from '../components/EventsCard';
import { ErrorMessage, Loading } from '../components/Status';
import { useUser } from '../lib/auth';
import { canApprove } from '../lib/permissions';
import { useAsync } from '../lib/useAsync';

export function HealthPage() {
  const user = useUser();
  const health = useAsync(fetchHealth);

  return (
    <div className="space-y-6">
      <section aria-labelledby="health-heading" className="rounded-lg border bg-white p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="health-heading" className="font-semibold">
            System health
          </h2>
          <button
            type="button"
            onClick={health.reload}
            className="rounded border px-3 py-1 text-sm hover:bg-slate-100 focus:outline-2 focus:outline-sky-500"
          >
            Refresh
          </button>
        </div>

        {health.status === 'loading' && <Loading label="Checking…" />}
        {health.status === 'error' && (
          <ErrorMessage message={`${health.error} Is \`npm run dev:api\` running?`} />
        )}
        {health.status === 'success' && (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-slate-500">API</dt>
            <dd>
              <Badge ok label="up" />
            </dd>
            <dt className="text-slate-500">Database</dt>
            <dd className="flex items-center gap-2">
              <Badge
                ok={health.data.checks.database.status === 'up'}
                label={health.data.checks.database.status}
              />
              {health.data.checks.database.latencyMs !== undefined && (
                <span className="text-slate-500">{health.data.checks.database.latencyMs} ms</span>
              )}
            </dd>
            <dt className="text-slate-500">Checked at</dt>
            <dd>{new Date(health.data.checkedAt).toLocaleString()}</dd>
            <dt className="text-slate-500">API uptime</dt>
            <dd>{health.data.uptimeSeconds}s</dd>
          </dl>
        )}
      </section>
      {canApprove(user) && <EventsCard />}
    </div>
  );
}
