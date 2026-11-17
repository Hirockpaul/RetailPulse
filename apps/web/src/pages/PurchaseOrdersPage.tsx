import { useCallback, useState } from 'react';
import { listPurchaseOrders, type PoStatus } from '../api/purchasing';
import { Badge } from '../components/Badge';
import { Pagination } from '../components/Pagination';
import { Empty, ErrorMessage, Loading } from '../components/Status';
import { field, table } from '../components/table';
import { formatDay, formatInt, formatMoney } from '../lib/format';
import { href } from '../lib/router';
import { useAsync } from '../lib/useAsync';

const TONE = { APPROVED: 'warn', RECEIVED: 'good', CANCELLED: 'bad' } as const;
const PAGE_SIZE = 20;

export function PurchaseOrderStatusBadge({ status }: { status: PoStatus }) {
  const label = { APPROVED: 'Ordered', RECEIVED: 'Received', CANCELLED: 'Cancelled' }[status];
  return <Badge tone={TONE[status]} label={label} />;
}

export function PurchaseOrdersPage() {
  const [status, setStatus] = useState<PoStatus | ''>('');
  const [page, setPage] = useState(1);
  const orders = useAsync(
    useCallback(
      () => listPurchaseOrders({ status: status || undefined, page, pageSize: PAGE_SIZE }),
      [status, page],
    ),
  );

  return (
    <section aria-labelledby="po-heading" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="po-heading" className="text-xl font-semibold">
            Purchase orders
          </h2>
          <p className="text-sm text-slate-500">
            Created when a manager approves an order recommendation. Stock is added only when the
            delivery is received.
          </p>
        </div>
        <label className="flex flex-col text-xs text-slate-500">
          Status
          <select
            className={field}
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as PoStatus | '');
              setPage(1);
            }}
          >
            <option value="">All</option>
            <option value="APPROVED">Ordered (not yet received)</option>
            <option value="RECEIVED">Received</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
        </label>
      </div>

      {orders.status === 'loading' && <Loading />}
      {orders.status === 'error' && <ErrorMessage message={orders.error} onRetry={orders.reload} />}
      {orders.status === 'success' && orders.data.total === 0 && (
        <Empty>No purchase orders{status ? ' with that status' : ' yet'}.</Empty>
      )}
      {orders.status === 'success' && orders.data.total > 0 && (
        <>
          <div className={table.wrap}>
            <table className={table.table}>
              <thead className={table.thead}>
                <tr>
                  <th className={table.th}>Order</th>
                  <th className={table.th}>Supplier</th>
                  <th className={table.th}>Deliver to</th>
                  <th className={table.thNum}>Units</th>
                  <th className={table.thNum}>Cost</th>
                  <th className={table.th}>Expected</th>
                  <th className={table.th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {orders.data.data.map((o) => (
                  <tr key={o.id} className={table.row}>
                    <td className={table.td}>
                      <a className={table.link} href={href.purchaseOrder(o.id)}>
                        {o.id.slice(0, 8)}
                      </a>
                    </td>
                    <td className={table.td}>{o.supplierName}</td>
                    <td className={table.td}>{o.destinationCode}</td>
                    <td className={table.tdNum}>{formatInt(o.totalUnits)}</td>
                    <td className={table.tdNum}>{formatMoney(o.totalCost)}</td>
                    <td className={table.td}>{formatDay(o.expectedDate)}</td>
                    <td className={table.td}>
                      <PurchaseOrderStatusBadge status={o.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={orders.data.page}
            pageSize={orders.data.pageSize}
            total={orders.data.total}
            onPage={setPage}
          />
        </>
      )}
    </section>
  );
}
