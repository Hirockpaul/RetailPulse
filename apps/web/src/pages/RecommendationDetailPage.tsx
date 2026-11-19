import { useCallback, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import {
  approveRecommendation,
  fetchRecommendationWords,
  getRecommendation,
  rejectRecommendation,
  type ExcessInputs,
  type NeedInputs,
  type RecommendationWords,
} from '../api/replenishment';
import { Badge } from '../components/Badge';
import {
  actionLabel,
  RecommendationStatusBadge,
  REVIEW_REASON_TEXT,
  ReviewBadge,
  RiskBadge,
} from '../components/RecommendationBadges';
import { ErrorMessage, Loading } from '../components/Status';
import { field, table } from '../components/table';
import { useUser } from '../lib/auth';
import { formatDateTime, formatDay, formatDecimal, formatInt, formatPercent } from '../lib/format';
import { canApprove } from '../lib/permissions';
import { href } from '../lib/router';
import { useAsync } from '../lib/useAsync';

export function RecommendationDetailPage({ id }: { id: string }) {
  const user = useUser();
  const rec = useAsync(useCallback(() => getRecommendation(id), [id]));
  const [note, setNote] = useState('');
  // Flagged recommendations: the manager's own quantity (pre-filled with the suggestion).
  const [quantity, setQuantity] = useState<string | null>(null);
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (kind: 'approve' | 'reject') => {
    setBusy(kind);
    setError(null);
    try {
      const text = note.trim() || undefined;
      const flagged = rec.status === 'success' && rec.data.reviewReason !== null;
      const chosen = flagged ? Number(quantity ?? rec.data.quantity) : undefined;
      await (kind === 'approve'
        ? approveRecommendation(id, text, chosen)
        : rejectRecommendation(id, text));
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
                <ReviewBadge reason={rec.data.reviewReason} />
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
            {rec.data.expectedStockoutOn && (
              <p className="mt-1 text-sm text-slate-600">
                Expected stockout: <strong>{formatDay(rec.data.expectedStockoutOn)}</strong>
                {'stockout' in rec.data.inputs &&
                  rec.data.inputs.stockout?.beyondForecast &&
                  ' (estimate beyond the forecast)'}
              </p>
            )}
            {rec.data.reviewReason && (
              <p className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
                Needs a manual review — {REVIEW_REASON_TEXT[rec.data.reviewReason]}. The suggested
                quantity is only a starting point: enter the quantity to approve and a note.
              </p>
            )}

            {rec.data.status === 'PENDING' && canApprove(user) && (
              <div className="mt-4 space-y-3 border-t pt-4">
                <div className="flex flex-wrap gap-3">
                  {rec.data.reviewReason && (
                    <label className="flex flex-col text-xs text-slate-500">
                      Quantity to approve
                      <input
                        className={`${field} w-32`}
                        type="number"
                        inputMode="numeric"
                        min={1}
                        step={1}
                        required
                        value={quantity ?? String(rec.data.quantity)}
                        onChange={(e) => setQuantity(e.target.value)}
                      />
                    </label>
                  )}
                  <label className="flex min-w-0 flex-1 flex-col text-xs text-slate-500">
                    {rec.data.reviewReason ? 'Note (required to approve)' : 'Note (optional)'}
                    <input
                      className={`${field} max-w-xl`}
                      maxLength={200}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                    />
                  </label>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => decide('approve')}
                    className="rounded bg-slate-900 px-4 py-1.5 text-sm text-white enabled:hover:bg-slate-700 disabled:opacity-50 focus:outline-2 focus:outline-sky-500"
                  >
                    {busy === 'approve'
                      ? 'Approving…'
                      : rec.data.action === 'TRANSFER' || rec.data.action === 'REDISTRIBUTE_EXCESS'
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
                  {rec.data.action === 'TRANSFER' || rec.data.action === 'REDISTRIBUTE_EXCESS'
                    ? 'transfer'
                    : 'purchase order'}{' '}
                  but moves no stock by itself.
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
                {rec.data.approvedQuantity !== null &&
                  rec.data.approvedQuantity !== rec.data.quantity && (
                    <>Approved quantity: {formatInt(rec.data.approvedQuantity)} units. </>
                  )}
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
            <Words id={id} />
          </section>

          {rec.data.inputs.kind === 'EXCESS' ? (
            <ExcessCards inputs={rec.data.inputs} />
          ) : (
            <NeedCards inputs={rec.data.inputs} />
          )}
          <p className="text-xs text-slate-500">
            Generated {formatDateTime(rec.data.generatedAt)}. Stock and forecast may have changed
            since; use Recalculate on the Replenishment page for a fresh suggestion.
          </p>
        </>
      )}
    </section>
  );
}

type WordsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'success'; data: RecommendationWords };

function Words({ id }: { id: string }) {
  const requestNumber = useRef(0);
  const [settled, setSettled] = useState<{ id: string; state: WordsState }>({
    id,
    state: { status: 'idle' },
  });
  const state = settled.id === id ? settled.state : { status: 'idle' as const };

  const load = async () => {
    const request = ++requestNumber.current;
    setSettled({ id, state: { status: 'loading' } });
    try {
      const data = await fetchRecommendationWords(id);
      if (request === requestNumber.current) {
        setSettled({ id, state: { status: 'success', data } });
      }
    } catch (caught) {
      if (request === requestNumber.current) {
        setSettled({
          id,
          state: {
            status: 'error',
            message: caught instanceof ApiError ? caught.message : 'Unexpected error.',
          },
        });
      }
    }
  };

  return (
    <div className="border-t pt-3">
      <button
        type="button"
        onClick={() => void load()}
        disabled={state.status === 'loading'}
        className="rounded bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-800 disabled:cursor-wait disabled:opacity-60"
      >
        {state.status === 'loading' ? 'Explaining…' : 'Explain in words'}
      </button>
      <div className="mt-3" aria-live="polite">
        {state.status === 'error' && <ErrorMessage message={state.message} onRetry={load} />}
        {state.status === 'success' && (
          <div className="space-y-2 rounded border border-sky-100 bg-sky-50 p-3 text-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-sky-800">
              {state.data.source === 'ai'
                ? `AI-generated explanation (${state.data.provider === 'nvidia' ? 'NVIDIA' : 'Groq'})`
                : 'Template explanation'}
            </p>
            {state.data.claims.map((claim, index) => (
              <p key={`${claim.type}-${index}`}>
                <span className="mr-2 rounded bg-white px-1.5 py-0.5 text-xs font-medium text-slate-600">
                  {claim.type}
                </span>
                {claim.text}
              </p>
            ))}
            <p className="text-xs text-slate-500">
              {state.data.source === 'ai'
                ? 'AI reworded the stored calculation; it did not choose the quantity or approve anything.'
                : 'This explanation was produced locally from the stored calculation.'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

const LEAD_BASIS: Record<string, string> = {
  transfer: 'transfer',
  measured: 'supplier, measured',
  promised: 'supplier, as promised',
};

function StockCard({ stock }: { stock: NeedInputs['stock'] | ExcessInputs['stock'] }) {
  return (
    <InputsCard title="Stock position">
      <Row label="On hand" value={formatInt(stock.onHand)} />
      <Row label="Reserved" value={formatInt(stock.reserved)} />
      <Row label="Available" value={formatInt(stock.available)} />
      <Row label="Inbound (approved transfers / orders)" value={formatInt(stock.inbound)} />
      {'promisedOut' in stock && (
        <Row label="Promised to outgoing transfers" value={formatInt(stock.promisedOut)} />
      )}
      <Row label="Position" value={formatInt(stock.position)} strong />
    </InputsCard>
  );
}

function ForecastCard({ forecast }: { forecast: NeedInputs['forecast'] }) {
  return (
    <InputsCard title="Forecast">
      <Row label="Model" value={forecast.model} />
      <Row label="Demand per day (lead time)" value={formatDecimal(forecast.avgDailyDemand)} />
      <Row label="Demand during lead time" value={formatDecimal(forecast.demandDuringLead)} />
      {forecast.sigmaError !== undefined ? (
        <Row label="Typical daily forecast error (σe)" value={formatDecimal(forecast.sigmaError)} />
      ) : (
        <Row label="Daily demand spread (σ)" value={formatDecimal(forecast.sigmaDaily ?? 0)} />
      )}
      <Row label="History" value={`${forecast.historyDays} days`} />
      <Row
        label="Accuracy on test window"
        value={forecast.testWape === null ? 'not measured' : formatPercent(forecast.testWape)}
      />
      {forecast.isFallback && (
        <p className="pt-1">
          <Badge tone="warn" label="Category-average fallback: little sales history" />
        </p>
      )}
    </InputsCard>
  );
}

function NeedCards({ inputs }: { inputs: NeedInputs }) {
  return (
    <div className="grid gap-5 md:grid-cols-3">
      <StockCard stock={inputs.stock} />
      <ForecastCard forecast={inputs.forecast} />
      <InputsCard title="Calculation">
        <Row
          label={`Lead time (${LEAD_BASIS[inputs.parameters.leadTimeBasis ?? 'v1'] ?? inputs.parameters.leadTimeSource})`}
          value={`${formatDecimal(inputs.parameters.leadTimeDays)} days`}
        />
        {inputs.parameters.leadTimeStdDays !== undefined && (
          <Row
            label="Lead-time spread (σL)"
            value={`${formatDecimal(inputs.parameters.leadTimeStdDays)} days`}
          />
        )}
        {inputs.parameters.serviceLevel !== undefined && (
          <Row
            label={`Service level (${inputs.parameters.classification?.cls && inputs.parameters.classification.cls !== 'NEW' ? `class ${inputs.parameters.classification.cls}` : 'default'})`}
            value={formatPercent(inputs.parameters.serviceLevel)}
          />
        )}
        <Row label="Service level z" value={String(inputs.parameters.serviceLevelZ)} />
        <Row label="Safety stock" value={formatDecimal(inputs.calculation.safetyStock)} />
        <Row label="Reorder point" value={formatDecimal(inputs.calculation.reorderPoint)} />
        <Row label="Order-up-to level" value={formatDecimal(inputs.calculation.orderUpTo)} />
        <Row label="Need" value={formatDecimal(inputs.calculation.rawQuantity)} />
        <Row
          label={`Rounded to packs of ${inputs.parameters.packSize}`}
          value={formatInt(inputs.calculation.quantity)}
          strong
        />
      </InputsCard>
    </div>
  );
}

function ExcessCards({ inputs }: { inputs: ExcessInputs }) {
  return (
    <div className="grid gap-5 md:grid-cols-3">
      <StockCard stock={inputs.stock} />
      <InputsCard title="Forecast and keep level">
        <Row label="Model" value={inputs.forecast.model} />
        <Row label="History" value={`${inputs.forecast.historyDays} days`} />
        <Row
          label={`Forecast demand (${inputs.excess.keepDays} days)`}
          value={formatDecimal(inputs.excess.demandKeep)}
        />
        <Row label="Reorder point" value={formatDecimal(inputs.excess.reorderPoint)} />
        <Row label="Units kept" value={formatDecimal(inputs.excess.keep)} strong />
      </InputsCard>
      <InputsCard title="Excess move">
        <Row label="Excess above keep level" value={formatDecimal(inputs.excess.excess)} />
        <Row
          label={`Movable in packs of ${inputs.excess.packSize}`}
          value={formatInt(inputs.excess.movable)}
          strong
        />
        <Row label="Destination" value={inputs.destination.code} />
        <Row
          label="Destination stock before move"
          value={formatInt(inputs.destination.available)}
        />
      </InputsCard>
    </div>
  );
}

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
