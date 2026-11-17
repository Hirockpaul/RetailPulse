import { useCallback, useState } from 'react';
import { type AlertStatus, listAlerts, rescanAlerts } from '../api/alerts';
import { ApiError } from '../api/client';
import { Badge } from '../components/Badge';
import { Pagination } from '../components/Pagination';
import { Empty, ErrorMessage, Loading } from '../components/Status';
import { field, table } from '../components/table';
import { useUser } from '../lib/auth';
import { formatDateTime, formatInt } from '../lib/format';
import { canApprove } from '../lib/permissions';
import { href } from '../lib/router';
import { useAsync } from '../lib/useAsync';

const PAGE_SIZE = 25;

export function AlertsPage() {
  const user = useUser();
  const [status, setStatus] = useState<AlertStatus>('OPEN');
  const [page, setPage] = useState(1);
  const [rescanMessage, setRescanMessage] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState(false);

  const alerts = useAsync(
    useCallback(() => listAlerts({ status, page, pageSize: PAGE_SIZE }), [status, page]),
  );

  const rescan = async () => {
    setRescanning(true);
    setRescanMessage(null);
    try {
      const { evaluated } = await rescanAlerts();
      setRescanMessage(`Checked ${formatInt(evaluated)} stock positions against current stock.`);
      alerts.reload();
    } catch (err) {
      setRescanMessage(err instanceof ApiError ? err.message : 'Re-scan failed.');
    } finally {
      setRescanning(false);
    }
  };

  return (
    <section aria-labelledby="alerts-heading" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="alerts-heading" className="text-xl font-semibold">
            Stock alerts
          </h2>
          <p className="text-sm text-slate-500">
            Raised automatically after every stock movement: <strong>low</strong> = less than one
            pack available (on hand − reserved), <strong>out</strong> = nothing available.
          </p>
        </div>
        <div className="flex items-end gap-3">
          <label className="flex flex-col text-xs text-slate-500">
            Show
            <select
              className={field}
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as AlertStatus);
                setPage(1);
              }}
            >
              <option value="OPEN">Open alerts</option>
              <option value="RESOLVED">Resolved alerts</option>
            </select>
          </label>
          {canApprove(user) && (
            <button
              type="button"
              onClick={rescan}
              disabled={rescanning}
              title="Re-check every low stock position against current stock"
              className={`${field} enabled:hover:bg-slate-100 disabled:opacity-50`}
            >
              {rescanning ? 'Checking…' : 'Re-scan stock'}
            </button>
          )}
        </div>
      </div>

      {rescanMessage && (
        <p role="status" className="text-sm text-slate-600">
          {rescanMessage}
        </p>
      )}

      {alerts.status === 'loading' && <Loading />}
      {alerts.status === 'error' && <ErrorMessage message={alerts.error} onRetry={alerts.reload} />}
      {alerts.status === 'success' && alerts.data.total === 0 && (
        <Empty>
          {status === 'OPEN'
            ? 'No open alerts. Alerts appear after stock movements that leave a product low.'
            : 'No resolved alerts yet.'}
        </Empty>
      )}
      {alerts.status === 'success' && alerts.data.total > 0 && (
        <>
          <div className={table.wrap}>
            <table className={table.table}>
              <thead className={table.thead}>
                <tr>
                  <th className={table.th}>Severity</th>
                  <th className={table.th}>Product</th>
                  <th className={table.th}>Location</th>
                  <th className={table.thNum}>Available</th>
                  <th className={table.thNum}>Pack size</th>
                  <th className={table.th}>{status === 'OPEN' ? 'Since' : 'Resolved'}</th>
                </tr>
              </thead>
              <tbody>
                {alerts.data.data.map((a) => (
                  <tr key={a.id} className={table.row} title={a.message}>
                    <td className={table.td}>
                      <Badge
                        tone={a.severity === 'HIGH' ? 'bad' : 'warn'}
                        label={a.kind === 'OUT_OF_STOCK' ? 'Out of stock' : 'Low stock'}
                      />
                    </td>
                    <td className={table.td}>
                      <a className={table.link} href={href.product(a.productId)}>
                        {a.sku}
                      </a>{' '}
                      <span className="text-slate-500">{a.productName}</span>
                    </td>
                    <td className={table.td}>{a.locationCode}</td>
                    <td className={table.tdNum}>{a.details.available ?? '—'}</td>
                    <td className={table.tdNum}>{a.details.packSize ?? '—'}</td>
                    <td className={table.td}>
                      {formatDateTime(
                        status === 'OPEN' ? a.createdAt : (a.resolvedAt ?? a.createdAt),
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={alerts.data.page}
            pageSize={alerts.data.pageSize}
            total={alerts.data.total}
            onPage={setPage}
          />
        </>
      )}
    </section>
  );
}
