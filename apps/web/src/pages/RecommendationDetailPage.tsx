import { useCallback, useState } from 'react';
import { ApiError } from '../api/client';
import {
  approveRecommendation,
  getRecommendation,
  rejectRecommendation,
} from '../api/replenishment';
import { Badge } from '../components/Badge';
import {
  actionLabel,
  RecommendationStatusBadge,
  RiskBadge,
} from '../components/RecommendationBadges';
import { ErrorMessage, Loading } from '../components/Status';
import { field, table } from '../components/table';
import { useUser } from '../lib/auth';
import { formatDateTime, formatDecimal, formatInt, formatPercent } from '../lib/format';
import { canApprove } from '../lib/permissions';
import { href } from '../lib/router';
import { useAsync } from '../lib/useAsync';

export function RecommendationDetailPage({ id }: { id: string }) {
  const user = useUser();
  const rec = useAsync(useCallback(() => getRecommendation(id), [id]));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (kind: 'approve' | 'reject') => {
    setBusy(kind);
    setError(null);
    try {
      const text = note.trim() || undefined;
      await (kind === 'approve' ? approveRecommendation(id, text) : rejectRecommendation(id, text));
      rec.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unexpected error.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="space-y-5">
      <a className={table.link} href={href.replenishment()}>
        ← All recommendations
      </a>

      {rec.status === 'loading' && <Loading />}
      {rec.status === 'error' && (
        <ErrorMessage
          message={rec.httpStatus === 404 ? 'Recommendation not found.' : rec.error}
          onRetry={rec.httpStatus === 404 || rec.httpStatus === 403 ? undefined : rec.reload}
        />
      )}
      {rec.status === 'success' && (
        <>
          <header className="rounded-lg border bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm text-slate-500">
                  <a className={table.link} href={href.product(rec.data.productId)}>
                    {rec.data.sku}
                  </a>{' '}
                  at {rec.data.locationCode}
                </p>
                <h2 className="text-xl font-semibold">{rec.data.productName}</h2>
              </div>
              <div className="flex items-center gap-2">
                <RiskBadge risk={rec.data.risk} />
                <RecommendationStatusBadge status={rec.data.status} />
              </div>
            </div>
            <p className="mt-3 text-lg">
              {actionLabel(rec.data)}: <strong>{formatInt(rec.data.quantity)} units</strong>{' '}
              <span className="text-sm text-slate-500">
                ({formatInt(rec.data.quantity / rec.data.packSize)} packs of {rec.data.packSize})
              </span>
            </p>

            {rec.data.status === 'PENDING' && canApprove(user) && (
              <div className="mt-4 space-y-3 border-t pt-4">
                <label className="flex flex-col text-xs text-slate-500">
                  Note (optional)
                  <input
                    className={`${field} max-w-xl`}
                    maxLength={200}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => decide('approve')}
                    className="rounded bg-slate-900 px-4 py-1.5 text-sm text-white enabled:hover:bg-slate-700 disabled:opacity-50 focus:outline-2 focus:outline-sky-500"
                  >
                    {busy === 'approve'
                      ? 'Approving…'
                      : rec.data.action === 'TRANSFER'
                        ? 'Approve and create transfer'
                        : 'Approve and create purchase order'}
                  </button>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => decide('reject')}
                    className="rounded border px-4 py-1.5 text-sm text-red-700 enabled:hover:bg-red-50 disabled:opacity-50 focus:outline-2 focus:outline-sky-500"
                  >
                    {busy === 'reject' ? 'Rejecting…' : 'Reject'}
                  </button>
                </div>
                <p className="text-xs text-slate-500">
                  Approving creates the{' '}
                  {rec.data.action === 'TRANSFER' ? 'transfer' : 'purchase order'} but moves no
                  stock by itself.
                </p>
              </div>
            )}
            {rec.data.status === 'PENDING' && !canApprove(user) && (
              <p className="mt-3 text-sm text-slate-500">
                Waiting for an inventory manager or admin to decide.
              </p>
            )}
            {rec.data.status !== 'PENDING' && (
              <p className="mt-3 text-sm text-slate-600">
                {rec.data.status === 'EXPIRED'
                  ? 'Replaced by a newer calculation.'
                  : `${rec.data.status === 'APPROVED' ? 'Approved' : 'Rejected'} by ${rec.data.decidedBy} on ${
                      rec.data.decidedAt ? formatDateTime(rec.data.decidedAt) : '—'
                    }.`}{' '}
                {rec.data.decisionNote && <>Note: “{rec.data.decisionNote}”. </>}
                {rec.data.transferId && (
                  <a className={table.link} href={href.transfer(rec.data.transferId)}>
                    View the transfer →
                  </a>
                )}
                {rec.data.purchaseOrderId && (
                  <a className={table.link} href={href.purchaseOrder(rec.data.purchaseOrderId)}>
                    View the purchase order →
                  </a>
                )}
              </p>
            )}
            {error && (
              <p role="alert" className="mt-3 text-sm text-red-700">
                {error}
              </p>
            )}
          </header>

          <section
            aria-labelledby="why-heading"
            className="space-y-2 rounded-lg border bg-white p-5"
          >
            <h3 id="why-heading" className="font-semibold">
              Why this suggestion
            </h3>
            <ol className="list-decimal space-y-1.5 pl-5 text-sm">
              {rec.data.explanation.split(/(?<=\.)\s+(?=[A-Z])/).map((sentence) => (
                <li key={sentence}>{sentence}</li>
              ))}
            </ol>
            <p className="text-xs text-slate-500">
              The calculation is deterministic arithmetic on the forecast and current stock — no
              hidden model decides the quantity.
            </p>
          </section>

          <div className="grid gap-5 md:grid-cols-3">
            <InputsCard title="Stock position">
              <Row label="On hand" value={formatInt(rec.data.inputs.stock.onHand)} />
              <Row label="Reserved" value={formatInt(rec.data.inputs.stock.reserved)} />
              <Row label="Available" value={formatInt(rec.data.inputs.stock.available)} />
              <Row
                label="Inbound (approved transfers / orders)"
                value={formatInt(rec.data.inputs.stock.inbound)}
              />
              <Row label="Position" value={formatInt(rec.data.inputs.stock.position)} strong />
            </InputsCard>

            <InputsCard title="Forecast">
              <Row label="Model" value={rec.data.inputs.forecast.model} />
              <Row
                label="Demand per day (lead time)"
                value={formatDecimal(rec.data.inputs.forecast.avgDailyDemand)}
              />
              <Row
                label="Demand during lead time"
                value={formatDecimal(rec.data.inputs.forecast.demandDuringLead)}
              />
              {rec.data.inputs.forecast.sigmaError !== undefined ? (
                <Row
                  label="Typical daily forecast error (σe)"
                  value={formatDecimal(rec.data.inputs.forecast.sigmaError)}
                />
              ) : (
                <Row
                  label="Daily demand spread (σ)"
                  value={formatDecimal(rec.data.inputs.forecast.sigmaDaily ?? 0)}
                />
              )}
              <Row label="History" value={`${rec.data.inputs.forecast.historyDays} days`} />
              <Row
                label="Accuracy on test window"
                value={
                  rec.data.inputs.forecast.testWape === null
                    ? 'not measured'
                    : formatPercent(rec.data.inputs.forecast.testWape)
                }
              />
              {rec.data.inputs.forecast.isFallback && (
                <p className="pt-1">
                  <Badge tone="warn" label="Category-average fallback: little sales history" />
                </p>
              )}
            </InputsCard>

            <InputsCard title="Calculation">
              <Row
                label={`Lead time (${LEAD_BASIS[rec.data.inputs.parameters.leadTimeBasis ?? 'v1'] ?? rec.data.inputs.parameters.leadTimeSource})`}
                value={`${formatDecimal(rec.data.inputs.parameters.leadTimeDays)} days`}
              />
              {rec.data.inputs.parameters.leadTimeStdDays !== undefined && (
                <Row
                  label="Lead-time spread (σL)"
                  value={`${formatDecimal(rec.data.inputs.parameters.leadTimeStdDays)} days`}
                />
              )}
              {rec.data.inputs.parameters.serviceLevel !== undefined && (
                <Row
                  label={`Service level (${rec.data.inputs.parameters.classification?.cls && rec.data.inputs.parameters.classification.cls !== 'NEW' ? `class ${rec.data.inputs.parameters.classification.cls}` : 'default'})`}
                  value={formatPercent(rec.data.inputs.parameters.serviceLevel)}
                />
              )}
              <Row
                label="Service level z"
                value={String(rec.data.inputs.parameters.serviceLevelZ)}
              />
              <Row
                label="Safety stock"
                value={formatDecimal(rec.data.inputs.calculation.safetyStock)}
              />
              <Row
                label="Reorder point"
                value={formatDecimal(rec.data.inputs.calculation.reorderPoint)}
              />
              <Row
                label="Order-up-to level"
                value={formatDecimal(rec.data.inputs.calculation.orderUpTo)}
              />
              <Row label="Need" value={formatDecimal(rec.data.inputs.calculation.rawQuantity)} />
              <Row
                label={`Rounded to packs of ${rec.data.inputs.parameters.packSize}`}
                value={formatInt(rec.data.inputs.calculation.quantity)}
                strong
              />
            </InputsCard>
          </div>
          <p className="text-xs text-slate-500">
            Generated {formatDateTime(rec.data.generatedAt)}. Stock and forecast may have changed
            since; use Recalculate on the Replenishment page for a fresh suggestion.
          </p>
        </>
      )}
    </section>
  );
}

const LEAD_BASIS: Record<string, string> = {
  transfer: 'transfer',
  measured: 'supplier, measured',
  promised: 'supplier, as promised',
};

function InputsCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border bg-white p-4">
      <h4 className="mb-2 text-sm font-semibold">{title}</h4>
      <dl className="space-y-1 text-sm">{children}</dl>
    </section>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className={strong ? 'font-semibold' : ''}>{value}</dd>
    </div>
  );
}
