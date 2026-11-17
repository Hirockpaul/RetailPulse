import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api/client';
import { fetchHealth, type HealthReport } from '../api/health';
import { Badge } from '../components/Badge';

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; report: HealthReport };

export function HealthPage() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(() => {
    fetchHealth()
      .then((report) => setState({ kind: 'ready', report }))
      .catch((err: unknown) =>
        setState({
          kind: 'error',
          message: err instanceof ApiError ? err.message : 'Unexpected error.',
        }),
      );
  }, []);

  useEffect(load, [load]);

  const refresh = () => {
    setState({ kind: 'loading' });
    load();
  };

  return (
    <section aria-labelledby="health-heading" className="rounded-lg border bg-white p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 id="health-heading" className="font-semibold">
          System health
        </h2>
        <button
          type="button"
          onClick={refresh}
          className="rounded border px-3 py-1 text-sm hover:bg-slate-100 focus:outline-2 focus:outline-sky-500"
        >
          Refresh
        </button>
      </div>

      {state.kind === 'loading' && <p className="text-slate-500">Checking…</p>}

      {state.kind === 'error' && (
        <p role="alert" className="text-red-700">
          {state.message} Is <code>npm run dev:api</code> running?
        </p>
      )}

      {state.kind === 'ready' && (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-slate-500">API</dt>
          <dd>
            <Badge ok label="up" />
          </dd>
          <dt className="text-slate-500">Database</dt>
          <dd className="flex items-center gap-2">
            <Badge
              ok={state.report.checks.database.status === 'up'}
              label={state.report.checks.database.status}
            />
            {state.report.checks.database.latencyMs !== undefined && (
              <span className="text-slate-500">{state.report.checks.database.latencyMs} ms</span>
            )}
          </dd>
          <dt className="text-slate-500">Checked at</dt>
          <dd>{new Date(state.report.checkedAt).toLocaleString()}</dd>
          <dt className="text-slate-500">API uptime</dt>
          <dd>{state.report.uptimeSeconds}s</dd>
        </dl>
      )}
    </section>
  );
}
