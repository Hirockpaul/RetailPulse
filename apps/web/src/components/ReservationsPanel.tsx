import { useCallback, useState } from 'react';
import { listReservations, releaseReservation } from '../api/movements';
import { ApiError } from '../api/client';
import { formatDateTime, formatInt } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { Empty, ErrorMessage, Loading } from './Status';
import { table } from './table';

/**
 * Active reservations for one product, each with a Release button.
 * The parent remounts it (via `key`) to refresh after any stock movement.
 */
export function ReservationsPanel({
  productId,
  onChanged,
}: {
  productId: string;
  onChanged: () => void;
}) {
  const reservations = useAsync(
    useCallback(() => listReservations({ productId, status: 'ACTIVE', pageSize: 50 }), [productId]),
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const release = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await releaseReservation(id);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unexpected error.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section aria-labelledby="reservations-heading" className="space-y-2">
      <h3 id="reservations-heading" className="font-semibold">
        Active reservations
      </h3>
      {error && <ErrorMessage message={error} />}
      {reservations.status === 'loading' && <Loading />}
      {reservations.status === 'error' && (
        <ErrorMessage message={reservations.error} onRetry={reservations.reload} />
      )}
      {reservations.status === 'success' && reservations.data.total === 0 && (
        <Empty>No active reservations.</Empty>
      )}
      {reservations.status === 'success' && reservations.data.total > 0 && (
        <div className={table.wrap}>
          <table className={table.table}>
            <thead className={table.thead}>
              <tr>
                <th className={table.th}>Location</th>
                <th className={table.thNum}>Quantity</th>
                <th className={table.th}>Reference</th>
                <th className={table.th}>Reserved at</th>
                <th className={table.th}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {reservations.data.data.map((r) => (
                <tr key={r.id} className={table.row}>
                  <td className={table.td}>{r.locationCode}</td>
                  <td className={table.tdNum}>{formatInt(r.quantity)}</td>
                  <td className={table.td}>{r.reference ?? '—'}</td>
                  <td className={table.td}>{formatDateTime(r.createdAt)}</td>
                  <td className={table.td}>
                    <button
                      type="button"
                      disabled={busyId === r.id}
                      onClick={() => release(r.id)}
                      className="rounded border px-2 py-1 text-xs enabled:hover:bg-slate-100 disabled:opacity-50 focus:outline-2 focus:outline-sky-500"
                    >
                      {busyId === r.id ? 'Releasing…' : 'Release'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
