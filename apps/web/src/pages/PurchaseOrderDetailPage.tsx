import { useCallback, useState } from 'react';
import { ApiError } from '../api/client';
import { cancelPurchaseOrder, getPurchaseOrder, receivePurchaseOrder } from '../api/purchasing';
import { ErrorMessage, Loading } from '../components/Status';
import { table } from '../components/table';
import { useUser } from '../lib/auth';
import { formatDateTime, formatDay, formatInt, formatMoney } from '../lib/format';
import { canAccessLocation, canApprove, canWrite } from '../lib/permissions';
import { href } from '../lib/router';
import { useAsync } from '../lib/useAsync';
import { PurchaseOrderStatusBadge } from './PurchaseOrdersPage';

export function PurchaseOrderDetailPage({ id }: { id: string }) {
  const user = useUser();
  const order = useAsync(useCallback(() => getPurchaseOrder(id), [id]));
  const [busy, setBusy] = useState<'receive' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (kind: 'receive' | 'cancel') => {
    setBusy(kind);
    setError(null);
    try {
      await (kind === 'receive' ? receivePurchaseOrder(id) : cancelPurchaseOrder(id));
      order.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unexpected error.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="space-y-5">
      <a className={table.link} href={href.purchaseOrders()}>
        ← All purchase orders
      </a>
      {order.status === 'loading' && <Loading />}
      {order.status === 'error' && (
        <ErrorMessage
          message={order.httpStatus === 404 ? 'Purchase order not found.' : order.error}
          onRetry={order.httpStatus === 404 || order.httpStatus === 403 ? undefined : order.reload}
        />
      )}
      {order.status === 'success' && (
        <>
          <header className="rounded-xl border bg-card shadow-sm p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-xl font-semibold">
                {order.data.supplierName} → {order.data.destinationCode}
              </h2>
              <PurchaseOrderStatusBadge status={order.data.status} />
            </div>
            <p className="mt-1 text-sm text-slate-500">
              {formatInt(order.data.totalUnits)} units · {formatMoney(order.data.totalCost)} ·
              expected {formatDay(order.data.expectedDate)} · created by {order.data.createdBy} on{' '}
              {formatDateTime(order.data.createdAt)}
            </p>
            {order.data.receivedAt && (
              <p className="mt-1 text-sm text-slate-600">
                Received by {order.data.receivedBy} on {formatDateTime(order.data.receivedAt)}.
              </p>
            )}
            {order.data.cancelledAt && (
              <p className="mt-1 text-sm text-slate-600">
                Cancelled by {order.data.cancelledBy} on {formatDateTime(order.data.cancelledAt)}.
              </p>
            )}

            {order.data.status === 'APPROVED' && (
              <div className="mt-4 flex flex-wrap gap-2">
                {canWrite(user) && canAccessLocation(user, order.data.destinationLocationId) && (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => act('receive')}
                    title="Adds the ordered quantities to stock at the destination"
                    className="rounded bg-slate-900 px-4 py-1.5 text-sm text-white enabled:hover:bg-slate-700 disabled:opacity-50 focus:outline-2 focus:outline-sky-500"
                  >
                    {busy === 'receive' ? 'Receiving…' : 'Receive delivery'}
                  </button>
                )}
                {canApprove(user) && (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => act('cancel')}
                    className="rounded border px-4 py-1.5 text-sm text-red-700 enabled:hover:bg-red-50 disabled:opacity-50 focus:outline-2 focus:outline-sky-500"
                  >
                    {busy === 'cancel' ? 'Cancelling…' : 'Cancel order'}
                  </button>
                )}
              </div>
            )}
            {error && (
              <p role="alert" className="mt-3 text-sm text-red-700">
                {error}
              </p>
            )}
          </header>

          <div className={table.wrap}>
            <table className={table.table}>
              <thead className={table.thead}>
                <tr>
                  <th className={table.th}>SKU</th>
                  <th className={table.th}>Name</th>
                  <th className={table.thNum}>Quantity</th>
                  <th className={table.thNum}>Unit cost</th>
                </tr>
              </thead>
              <tbody>
                {order.data.lines.map((l) => (
                  <tr key={l.productId} className={table.row}>
                    <td className={table.td}>
                      <a className={table.link} href={href.product(l.productId)}>
                        {l.sku}
                      </a>
                    </td>
                    <td className={table.td}>{l.name}</td>
                    <td className={table.tdNum}>{formatInt(l.quantity)}</td>
                    <td className={table.tdNum}>{formatMoney(l.unitCost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
