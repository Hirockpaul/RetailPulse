import { type ReactNode, useCallback, useRef, useState } from 'react';
import {
  type AnomalyStatus,
  type AnomalyWords,
  fetchAnomalyWords,
  getAnomaly,
  reviewAnomaly,
} from '../api/anomalies';
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

          <Words id={id} />

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

type WordsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'success'; data: AnomalyWords };

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
      const data = await fetchAnomalyWords(id);
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
    <section
      aria-labelledby="plain-language-heading"
      className="space-y-3 rounded-lg border bg-white p-5"
    >
      <div>
        <h3 id="plain-language-heading" className="font-semibold">
          Plain-language explanation
        </h3>
        <p className="text-sm text-slate-600">
          Summarises what happened, the comparison, why it was flagged, and what to check.
        </p>
      </div>
      <button
        type="button"
        onClick={() => void load()}
        disabled={state.status === 'loading'}
        className="rounded bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-800 disabled:cursor-wait disabled:opacity-60"
      >
        {state.status === 'loading' ? 'Explaining…' : 'Explain in words'}
      </button>
      <div aria-live="polite">
        {state.status === 'error' && <ErrorMessage message={state.message} onRetry={load} />}
        {state.status === 'success' && (
          <div className="space-y-2 rounded border border-sky-100 bg-sky-50 p-3 text-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-sky-800">
              {state.data.source === 'ai' ? 'AI-generated explanation' : 'Template explanation'}
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
                ? 'AI reworded verified finding values; it did not review the case or change stock.'
                : 'This explanation was produced locally from the verified finding values.'}
            </p>
          </div>
        )}
      </div>
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
