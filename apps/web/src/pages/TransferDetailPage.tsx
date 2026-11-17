import { useCallback, useState } from 'react';
import { ApiError } from '../api/client';
import {
  getTransfer,
  type TransferDetail,
  transferStep,
  type TransferStep,
} from '../api/transfers';
import { Empty, ErrorMessage, Loading } from '../components/Status';
import { table } from '../components/table';
import { TransferStatusBadge } from '../components/TransferStatus';
import { useUser } from '../lib/auth';
import { formatDateTime, formatInt } from '../lib/format';
import { canAccessLocation, canApprove, canWrite } from '../lib/permissions';
import { href } from '../lib/router';
import { useAsync } from '../lib/useAsync';

const BUTTONS: { step: TransferStep; label: string; hint: string }[] = [
  { step: 'approve', label: 'Approve', hint: 'Approves the request. No stock moves yet.' },
  { step: 'dispatch', label: 'Dispatch', hint: 'Takes the stock out of the source location.' },
  { step: 'receive', label: 'Receive', hint: 'Adds the stock to the destination location.' },
  { step: 'cancel', label: 'Cancel', hint: 'Only possible before dispatch.' },
];

export function TransferDetailPage({ id }: { id: string }) {
  const user = useUser();
  const transfer = useAsync(useCallback(() => getTransfer(id), [id]));
  const [busy, setBusy] = useState<TransferStep | null>(null);
  const [error, setError] = useState<string | null>(null);

  // UI hints only; the API decides. Mirrors the server rules for who may do each step.
  const allowed = (t: TransferDetail, step: TransferStep): boolean => {
    if (!canWrite(user)) return false;
    switch (step) {
      case 'approve':
        return canApprove(user) && t.status === 'REQUESTED';
      case 'dispatch':
        return t.status === 'APPROVED' && canAccessLocation(user, t.sourceLocationId);
      case 'receive':
        return t.status === 'DISPATCHED' && canAccessLocation(user, t.destinationLocationId);
      case 'cancel':
        return (
          (t.status === 'REQUESTED' || t.status === 'APPROVED') &&
          (canAccessLocation(user, t.sourceLocationId) ||
            canAccessLocation(user, t.destinationLocationId))
        );
    }
  };

  const run = async (t: TransferDetail, step: TransferStep) => {
    setBusy(step);
    setError(null);
    try {
      await transferStep(id, step);
      transfer.reload();
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'INSUFFICIENT_STOCK'
          ? `Not enough stock at ${t.sourceCode} to dispatch this transfer. Nothing was changed.`
          : err instanceof ApiError
            ? err.message
            : 'Unexpected error.',
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="space-y-6">
      <a className={table.link} href={href.transfers()}>
        ← All transfers
      </a>

      {transfer.status === 'loading' && <Loading />}
      {transfer.status === 'error' && (
        <ErrorMessage
          message={transfer.httpStatus === 404 ? 'Transfer not found.' : transfer.error}
          // Retrying cannot fix "not found" or "not allowed".
          onRetry={
            transfer.httpStatus === 404 || transfer.httpStatus === 403 ? undefined : transfer.reload
          }
        />
      )}
      {transfer.status === 'success' && (
        <>
          <header className="rounded-lg border bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-xl font-semibold">
                {transfer.data.sourceCode} → {transfer.data.destinationCode}
              </h2>
              <TransferStatusBadge status={transfer.data.status} />
            </div>
            <p className="mt-1 text-sm text-slate-500">
              {transfer.data.sourceName} to {transfer.data.destinationName} ·{' '}
              {formatInt(transfer.data.totalUnits)} units in {transfer.data.lineCount} product
              {transfer.data.lineCount === 1 ? '' : 's'}
            </p>
            {transfer.data.notes && <p className="mt-2 text-sm">Note: {transfer.data.notes}</p>}

            <div className="mt-4 flex flex-wrap gap-2">
              {BUTTONS.filter((b) => allowed(transfer.data, b.step)).map((b) => (
                <button
                  key={b.step}
                  type="button"
                  title={b.hint}
                  disabled={busy !== null}
                  onClick={() => run(transfer.data, b.step)}
                  className={`rounded px-4 py-1.5 text-sm focus:outline-2 focus:outline-sky-500 disabled:opacity-50 ${
                    b.step === 'cancel'
                      ? 'border text-red-700 enabled:hover:bg-red-50'
                      : 'bg-slate-900 text-white enabled:hover:bg-slate-700'
                  }`}
                >
                  {busy === b.step ? 'Working…' : b.label}
                </button>
              ))}
              {BUTTONS.every((b) => !allowed(transfer.data, b.step)) && (
                <p className="text-sm text-slate-500">
                  {transfer.data.status === 'RECEIVED' || transfer.data.status === 'CANCELLED'
                    ? 'This transfer is finished.'
                    : 'No action is available to you right now.'}
                </p>
              )}
            </div>
            {error && (
              <p role="alert" className="mt-3 text-sm text-red-700">
                {error}
              </p>
            )}
          </header>

          <section aria-labelledby="history-heading" className="space-y-2">
            <h3 id="history-heading" className="font-semibold">
              History
            </h3>
            <div className={table.wrap}>
              <table className={table.table}>
                <thead className={table.thead}>
                  <tr>
                    <th className={table.th}>Step</th>
                    <th className={table.th}>By</th>
                    <th className={table.th}>When</th>
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      ['Requested', transfer.data.requestedBy, transfer.data.requestedAt],
                      ['Approved', transfer.data.approvedBy, transfer.data.approvedAt],
                      ['Dispatched', transfer.data.dispatchedBy, transfer.data.dispatchedAt],
                      ['Received', transfer.data.receivedBy, transfer.data.receivedAt],
                      ['Cancelled', transfer.data.cancelledBy, transfer.data.cancelledAt],
                    ] as [string, string | null, string | null][]
                  )
                    .filter(([, , at]) => at !== null)
                    .map(([label, by, at]) => (
                      <tr key={label} className={table.row}>
                        <td className={table.td}>{label}</td>
                        <td className={table.td}>{by}</td>
                        <td className={table.td}>{formatDateTime(at!)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-labelledby="lines-heading" className="space-y-2">
            <h3 id="lines-heading" className="font-semibold">
              Products
            </h3>
            {transfer.data.lines.length === 0 ? (
              <Empty>No lines.</Empty>
            ) : (
              <div className={table.wrap}>
                <table className={table.table}>
                  <thead className={table.thead}>
                    <tr>
                      <th className={table.th}>SKU</th>
                      <th className={table.th}>Name</th>
                      <th className={table.thNum}>Quantity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transfer.data.lines.map((l) => (
                      <tr key={l.productId} className={table.row}>
                        <td className={table.td}>
                          <a className={table.link} href={href.product(l.productId)}>
                            {l.sku}
                          </a>
                        </td>
                        <td className={table.td}>{l.name}</td>
                        <td className={table.tdNum}>{formatInt(l.quantity)}</td>
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
