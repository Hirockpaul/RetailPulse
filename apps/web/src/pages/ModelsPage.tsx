import { useState } from 'react';
import { ApiError } from '../api/client';
import { activateModel, getModelRegistry, type ModelStatus, rollbackModel } from '../api/ml';
import { Badge } from '../components/Badge';
import { Empty, ErrorMessage, Loading } from '../components/Status';
import { field, table } from '../components/table';
import { useUser } from '../lib/auth';
import { formatDateTime, formatPercent } from '../lib/format';
import { canApprove } from '../lib/permissions';
import { href } from '../lib/router';
import { useAsync } from '../lib/useAsync';

const STATUS_TONE: Record<ModelStatus, 'neutral' | 'good' | 'warn' | 'bad'> = {
  CANDIDATE: 'neutral',
  ELIGIBLE: 'warn',
  ACTIVE: 'good',
  RETIRED: 'neutral',
  REJECTED: 'bad',
};

const metric = (value: number | null) => (value === null ? '—' : formatPercent(value));

type Decision = { id: string; name: string; action: 'activate' | 'rollback' };

export function ModelsPage() {
  const user = useUser();
  const registry = useAsync(getModelRegistry);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  const beginDecision = (next: Decision) => {
    setDecision(next);
    setReason('');
    setDecisionError(null);
  };

  const submit = async () => {
    if (!decision) return;
    setBusy(true);
    setDecisionError(null);
    try {
      const act = decision.action === 'activate' ? activateModel : rollbackModel;
      await act(decision.id, reason.trim());
      setDecision(null);
      setReason('');
      registry.reload();
    } catch (err) {
      setDecisionError(err instanceof ApiError ? err.message : 'Unexpected error.');
    } finally {
      setBusy(false);
    }
  };

  const activeId =
    registry.status === 'success'
      ? registry.data.models.find((model) => model.status === 'ACTIVE')?.id
      : undefined;
  const latest = registry.status === 'success' ? registry.data.history[0] : undefined;
  const mayDecide = canApprove(user);

  return (
    <section aria-labelledby="models-heading" className="space-y-5">
      <div className="space-y-1">
        <h2 id="models-heading" className="text-xl font-semibold">
          Model registry
        </h2>
        <p className="max-w-3xl text-sm text-slate-600">
          Forecast runs evaluate every listed production model, but serve only the{' '}
          <strong>ACTIVE</strong> model. An eligible candidate needs at least a 0.5 percentage-point
          validation WAPE improvement. Activation changes future runs only; existing forecasts and
          recommendations are never rewritten. Metrics shown here use synthetic data.
        </p>
        <p className="text-sm">
          <a className={table.link} href={href.monitoring()}>
            Model monitoring: drift, accuracy on new days and run health →
          </a>
        </p>
      </div>

      {registry.status === 'loading' && <Loading />}
      {registry.status === 'error' && (
        <ErrorMessage message={registry.error} onRetry={registry.reload} />
      )}
      {registry.status === 'success' && registry.data.models.length === 0 && (
        <Empty>No registered models yet. Run a forecast once to bootstrap the registry.</Empty>
      )}
      {registry.status === 'success' && registry.data.models.length > 0 && (
        <>
          <div className={table.wrap}>
            <table className={table.table}>
              <thead className={table.thead}>
                <tr>
                  <th className={table.th}>Model</th>
                  <th className={table.th}>State</th>
                  <th className={table.thNum}>Validation WAPE</th>
                  <th className={table.thNum}>Test WAPE</th>
                  <th className={table.th}>Training data</th>
                  <th className={table.th}>Artifact</th>
                  <th className={table.th}>Decision</th>
                </tr>
              </thead>
              <tbody>
                {registry.data.models.map((model) => {
                  const canRollback =
                    model.status === 'RETIRED' &&
                    Boolean(model.artifactPath) &&
                    latest?.fromModelId === model.id &&
                    latest.toModelId === activeId;
                  return (
                    <tr key={model.id} className={table.row}>
                      <td className={table.td}>
                        <span className="font-medium">
                          {model.name} v{model.version}
                        </span>
                        <span className="block text-xs text-slate-500">{model.description}</span>
                      </td>
                      <td className={table.td}>
                        <Badge tone={STATUS_TONE[model.status]} label={model.status} />
                        {model.eligibilityReason && (
                          <span className="mt-1 block max-w-sm text-xs text-slate-500">
                            {model.eligibilityReason}
                          </span>
                        )}
                      </td>
                      <td className={table.tdNum}>{metric(model.validationWape)}</td>
                      <td className={table.tdNum}>{metric(model.testWape)}</td>
                      <td className={table.td}>
                        {model.trainingStart && model.trainingEnd
                          ? `${model.trainingStart} → ${model.trainingEnd}`
                          : '—'}
                      </td>
                      <td className={table.td}>
                        {model.artifactPath && model.artifactSha256 ? (
                          <>
                            <span className="block">
                              Stored · schema {model.artifactSchemaVersion}
                            </span>
                            <span className="block font-mono text-xs text-slate-500">
                              SHA-256 {model.artifactSha256.slice(0, 12)}…
                            </span>
                          </>
                        ) : model.kind === 'FALLBACK' ? (
                          'Per-series policy'
                        ) : (
                          'Pending next forecast run'
                        )}
                      </td>
                      <td className={table.td}>
                        {mayDecide && model.status === 'ELIGIBLE' && model.artifactPath && (
                          <button
                            type="button"
                            className={table.link}
                            onClick={() =>
                              beginDecision({ id: model.id, name: model.name, action: 'activate' })
                            }
                          >
                            Activate
                          </button>
                        )}
                        {mayDecide && canRollback && (
                          <button
                            type="button"
                            className={table.link}
                            onClick={() =>
                              beginDecision({ id: model.id, name: model.name, action: 'rollback' })
                            }
                          >
                            Roll back
                          </button>
                        )}
                        {(!mayDecide || (model.status !== 'ELIGIBLE' && !canRollback)) && (
                          <span className="text-slate-500">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {decision && (
            <form
              aria-labelledby="model-decision-heading"
              className="rounded-lg border bg-white p-4"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <h3 id="model-decision-heading" className="font-semibold">
                {decision.action === 'activate' ? 'Activate' : 'Roll back to'} {decision.name}
              </h3>
              <p className="mt-1 text-sm text-slate-600">
                This affects the next forecast run. Give an auditable reason for the decision.
              </p>
              <label className="mt-3 flex max-w-xl flex-col text-xs text-slate-500">
                Reason
                <input
                  className={field}
                  value={reason}
                  minLength={5}
                  maxLength={500}
                  required
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              {decisionError && (
                <p role="alert" className="mt-2 text-sm text-red-700">
                  {decisionError}
                </p>
              )}
              <div className="mt-3 flex gap-2">
                <button
                  type="submit"
                  disabled={busy || reason.trim().length < 5}
                  className="rounded bg-slate-900 px-4 py-1.5 text-sm text-white enabled:hover:bg-slate-700 disabled:opacity-50 focus:outline-2 focus:outline-sky-500"
                >
                  {busy ? 'Saving…' : 'Confirm decision'}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setDecision(null)}
                  className="rounded border px-4 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50 focus:outline-2 focus:outline-sky-500"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          <section aria-labelledby="activation-history-heading" className="space-y-2">
            <h3 id="activation-history-heading" className="font-semibold">
              Activation history
            </h3>
            {registry.data.history.length === 0 ? (
              <Empty>No activation history yet.</Empty>
            ) : (
              <div className={table.wrap}>
                <table className={table.table}>
                  <thead className={table.thead}>
                    <tr>
                      <th className={table.th}>When</th>
                      <th className={table.th}>Action</th>
                      <th className={table.th}>Change</th>
                      <th className={table.th}>Who</th>
                      <th className={table.th}>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {registry.data.history.map((item) => (
                      <tr key={item.id} className={table.row}>
                        <td className={table.td}>{formatDateTime(item.createdAt)}</td>
                        <td className={table.td}>{item.action}</td>
                        <td className={table.td}>
                          {item.fromModel ? `${item.fromModel} → ` : ''}
                          {item.toModel}
                        </td>
                        <td className={table.td}>{item.actorName ?? 'System bootstrap'}</td>
                        <td className={table.td}>{item.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </section>
  );
}
