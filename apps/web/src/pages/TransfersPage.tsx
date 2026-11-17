import { useCallback, useState } from 'react';
import { listTransfers, TRANSFER_STATUSES, type TransferStatus } from '../api/transfers';
import { Pagination } from '../components/Pagination';
import { Empty, ErrorMessage, Loading } from '../components/Status';
import { field, table } from '../components/table';
import { TransferForm } from '../components/TransferForm';
import { TransferStatusBadge } from '../components/TransferStatus';
import { useUser } from '../lib/auth';
import { formatDateTime, formatInt } from '../lib/format';
import { canWrite } from '../lib/permissions';
import { href, navigate } from '../lib/router';
import { useAsync } from '../lib/useAsync';

const PAGE_SIZE = 20;

export function TransfersPage() {
  const user = useUser();
  const [status, setStatus] = useState<TransferStatus | ''>('');
  const [page, setPage] = useState(1);

  const transfers = useAsync(
    useCallback(
      () => listTransfers({ status: status || undefined, page, pageSize: PAGE_SIZE }),
      [status, page],
    ),
  );

  return (
    <section aria-labelledby="transfers-heading" className="space-y-6">
      <h2 id="transfers-heading" className="text-xl font-semibold">
        Stock transfers
      </h2>

      {canWrite(user) && <TransferForm onCreated={(id) => navigate(href.transfer(id))} />}

      <div className="space-y-3">
        <div className="flex items-end justify-between">
          <h3 className="font-semibold">All transfers</h3>
          <label className="flex flex-col text-xs text-slate-500">
            Status
            <select
              className={field}
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as TransferStatus | '');
                setPage(1);
              }}
            >
              <option value="">All statuses</option>
              {TRANSFER_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.charAt(0) + s.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
          </label>
        </div>

        {transfers.status === 'loading' && <Loading />}
        {transfers.status === 'error' && (
          <ErrorMessage message={transfers.error} onRetry={transfers.reload} />
        )}
        {transfers.status === 'success' && transfers.data.total === 0 && (
          <Empty>No transfers{status ? ' with that status' : ' yet'}.</Empty>
        )}
        {transfers.status === 'success' && transfers.data.total > 0 && (
          <>
            <div className={table.wrap}>
              <table className={table.table}>
                <thead className={table.thead}>
                  <tr>
                    <th className={table.th}>Requested</th>
                    <th className={table.th}>From → To</th>
                    <th className={table.thNum}>Products</th>
                    <th className={table.thNum}>Units</th>
                    <th className={table.th}>Status</th>
                    <th className={table.th}>By</th>
                  </tr>
                </thead>
                <tbody>
                  {transfers.data.data.map((t) => (
                    <tr key={t.id} className={table.row}>
                      <td className={table.td}>
                        <a className={table.link} href={href.transfer(t.id)}>
                          {formatDateTime(t.requestedAt)}
                        </a>
                      </td>
                      <td className={table.td}>
                        {t.sourceCode} → {t.destinationCode}
                      </td>
                      <td className={table.tdNum}>{formatInt(t.lineCount)}</td>
                      <td className={table.tdNum}>{formatInt(t.totalUnits)}</td>
                      <td className={table.td}>
                        <TransferStatusBadge status={t.status} />
                      </td>
                      <td className={table.td}>{t.requestedBy}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={transfers.data.page}
              pageSize={transfers.data.pageSize}
              total={transfers.data.total}
              onPage={setPage}
            />
          </>
        )}
      </div>
    </section>
  );
}
