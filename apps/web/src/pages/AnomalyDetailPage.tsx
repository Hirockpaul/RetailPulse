import { type ReactNode, useCallback, useState } from 'react';
import { type AnomalyStatus, getAnomaly, reviewAnomaly } from '../api/anomalies';
import { ApiError } from '../api/client';
import {
  AnomalyStatusBadge,
  KIND_LABEL,
  observedText,
  reliabilityText,
  SeverityBadge,
  STEP_LABEL,
} from '../components/AnomalyLabels';
import { ErrorMessage, Loading } from '../components/Status';
import { field, table } from '../components/table';
import { formatDateTime, formatDay } from '../lib/format';
import { href } from '../lib/router';
import { useAsync } from '../lib/useAsync';

const NOTE_REQUIRED: AnomalyStatus[] = ['CONFIRMED', 'DISMISSED', 'RESOLVED'];

/** One finding: why it was flagged, how much to trust it, and the review steps with history. */
export function AnomalyDetailPage({ id }: { id: string }) {
  const finding = useAsync(useCallback(() => getAnomaly(id), [id]));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<AnomalyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const step = async (status: AnomalyStatus) => {
    if (NOTE_REQUIRED.includes(status) && note.trim().length < 3) {
      setError('Please write a short note saying why.');
      return;
    }
    setBusy(status);
    setError(null);
    try {
      await reviewAnomaly(id, status, note.trim() || undefined);
      setNote('');
      finding.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the review.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="space-y-4">
      <p className="text-sm">
        <a className={table.link} href={href.anomalies()}>
          ← Unusual activity
        </a>
      </p>
      {finding.status === 'loading' && <Loading />}
      {finding.status === 'error' && (
        <ErrorMessage message={finding.error} onRetry={finding.reload} />
      )}
      {finding.status === 'success' && (
        <>
          <header className="space-y-3 rounded-lg border bg-white p-5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold">{KIND_LABEL[finding.data.kind]}</h2>
              <SeverityBadge severity={finding.data.severity} />
              <AnomalyStatusBadge status={finding.data.status} />
            </div>
            <p className="text-sm text-slate-600">
              <a className={table.link} href={href.product(finding.data.productId)}>
                {finding.data.sku}
              </a>{' '}
              {finding.data.productName} at{' '}
              <a className={table.link} href={href.stock(finding.data.locationId)}>
                {finding.data.locationCode}
              </a>{' '}
              on {formatDay(finding.data.day)} — {observedText(finding.data)}.
            </p>
            <p>{finding.data.explanation}</p>
            <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {reliabilityText(finding.data)}
            </p>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
              <Fact label="Found by">
                {finding.data.source === 'SALES' ? 'Forecast run' : 'Stock movement'} (
                {finding.data.rule})
              </Fact>
              <Fact label="Found at">{formatDateTime(finding.data.foundAt)}</Fact>
              <Fact label="Score">{finding.data.score}</Fact>
              <Fact label="Last review">
                {finding.data.reviewedAt ? formatDateTime(finding.data.reviewedAt) : 'not yet'}
              </Fact>
            </dl>
          </header>

          {finding.data.nextSteps.length > 0 && (
            <section
              aria-labelledby="review-heading"
              className="space-y-2 rounded-lg border bg-white p-5"
            >
              <h3 id="review-heading" className="font-semibold">
                Review
              </h3>
              <label className="flex flex-col gap-1 text-sm">
                Note (needed to confirm, dismiss or resolve)
                <textarea
                  className={`${field} min-h-16`}
                  maxLength={500}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
              <div className="flex flex-wrap gap-2">
                {finding.data.nextSteps.map((s) => (
                  <button
                    key={s}
                    type="button"
                    disabled={busy !== null}
                    onClick={() => step(s)}
                    className={`rounded px-4 py-1.5 text-sm focus:outline-2 focus:outline-sky-500 disabled:opacity-50 ${
                      s === 'DISMISSED'
                        ? 'border enabled:hover:bg-slate-100'
                        : 'bg-slate-900 text-white enabled:hover:bg-slate-700'
                    }`}
                  >
                    {busy === s ? 'Saving…' : STEP_LABEL[s]}
                  </button>
                ))}
              </div>
              {error && (
                <p role="alert" className="text-sm text-red-700">
                  {error}
                </p>
              )}
              <p className="text-xs text-slate-500">
                Reviewing records a decision only. If stock is wrong, fix it with an adjustment on
                the product page, so the change stays in the ledger.
              </p>
            </section>
          )}

          <section aria-labelledby="history-heading" className="space-y-2">
            <h3 id="history-heading" className="font-semibold">
              History
            </h3>
            {finding.data.history.length === 0 ? (
              <p className="text-sm text-slate-500">Nobody has reviewed this finding yet.</p>
            ) : (
              <ol className="space-y-2 text-sm">
                {finding.data.history.map((h, i) => (
                  <li key={i} className="rounded border bg-white px-3 py-2">
                    <span className="font-medium">
                      {h.fromStatus.toLowerCase()} → {h.toStatus.toLowerCase()}
                    </span>{' '}
                    by {h.actor}, {formatDateTime(h.at)}
                    {h.note && <p className="text-slate-600">“{h.note}”</p>}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      )}
    </section>
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
