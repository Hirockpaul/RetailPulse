import { useCallback, useState } from 'react';
import { type AnomalyKind, type AnomalyStatus, listAnomalies } from '../api/anomalies';
import {
  AnomalyStatusBadge,
  KIND_LABEL,
  observedText,
  SeverityBadge,
} from '../components/AnomalyLabels';
import { Pagination } from '../components/Pagination';
import { Empty, ErrorMessage, Loading } from '../components/Status';
import { field, table } from '../components/table';
import { formatDay } from '../lib/format';
import { href } from '../lib/router';
import { useAsync } from '../lib/useAsync';

const PAGE_SIZE = 25;

/** Unusual sales and stock activity for people to review. HIGH findings first. */
export function AnomaliesPage() {
  const [status, setStatus] = useState<AnomalyStatus | 'OPEN' | ''>('OPEN');
  const [severity, setSeverity] = useState<'HIGH' | 'MEDIUM' | ''>('');
  const [kind, setKind] = useState<AnomalyKind | ''>('');
  const [page, setPage] = useState(1);
  const findings = useAsync(
    useCallback(
      () =>
        listAnomalies({
          status: status || undefined,
          severity: severity || undefined,
          kind: kind || undefined,
          page,
          pageSize: PAGE_SIZE,
        }),
      [status, severity, kind, page],
    ),
  );
  const reset = () => setPage(1);

  return (
    <section aria-labelledby="anomalies-heading" className="space-y-4">
      <div className="space-y-1">
        <h2 id="anomalies-heading" className="text-xl font-semibold">
          Unusual activity
        </h2>
        <p className="max-w-3xl text-sm text-slate-600">
          Sales spikes and stops found after each forecast run, and unusual write-offs, adjustments
          and returns found after stock movements. A finding is a prompt to look, not proof of a
          problem: <strong>high</strong> sales spikes were real about half the time in testing,{' '}
          <strong>medium</strong> ones rarely. Reviewing a finding never changes stock.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-xs text-slate-500">
          Status
          <select
            className={field}
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as AnomalyStatus | 'OPEN' | '');
              reset();
            }}
          >
            <option value="OPEN">Open (new or investigating)</option>
            <option value="NEW">New</option>
            <option value="INVESTIGATING">Investigating</option>
            <option value="CONFIRMED">Confirmed</option>
            <option value="DISMISSED">Dismissed</option>
            <option value="RESOLVED">Resolved</option>
            <option value="">All</option>
          </select>
        </label>
        <label className="flex flex-col text-xs text-slate-500">
          Severity
          <select
            className={field}
            value={severity}
            onChange={(e) => {
              setSeverity(e.target.value as 'HIGH' | 'MEDIUM' | '');
              reset();
            }}
          >
            <option value="">All (high first)</option>
            <option value="HIGH">High only</option>
            <option value="MEDIUM">Medium only</option>
          </select>
        </label>
        <label className="flex flex-col text-xs text-slate-500">
          Type
          <select
            className={field}
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as AnomalyKind | '');
              reset();
            }}
          >
            <option value="">All types</option>
            {(Object.keys(KIND_LABEL) as AnomalyKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {findings.status === 'loading' && <Loading />}
      {findings.status === 'error' && (
        <ErrorMessage message={findings.error} onRetry={findings.reload} />
      )}
      {findings.status === 'success' && findings.data.total === 0 && (
        <Empty>
          Nothing matches. Sales findings appear after a forecast run (Replenishment → Refresh
          forecasts); stock findings appear after unusual adjustments or returns.
        </Empty>
      )}
      {findings.status === 'success' && findings.data.total > 0 && (
        <>
          <div className={table.wrap}>
            <table className={table.table}>
              <thead className={table.thead}>
                <tr>
                  <th className={table.th}>Severity</th>
                  <th className={table.th}>What</th>
                  <th className={table.th}>Product</th>
                  <th className={table.th}>Store</th>
                  <th className={table.th}>Day</th>
                  <th className={table.th}>Numbers</th>
                  <th className={table.th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {findings.data.data.map((f) => (
                  <tr key={f.id} className={table.row}>
                    <td className={table.td}>
                      <SeverityBadge severity={f.severity} />
                    </td>
                    <td className={table.td}>
                      <a className={table.link} href={href.anomaly(f.id)}>
                        {KIND_LABEL[f.kind]}
                      </a>
                    </td>
                    <td className={table.td}>
                      <a className={table.link} href={href.product(f.productId)}>
                        {f.sku}
                      </a>{' '}
                      <span className="text-slate-500">{f.productName}</span>
                    </td>
                    <td className={`${table.td} whitespace-nowrap`}>{f.locationCode}</td>
                    <td className={`${table.td} whitespace-nowrap`}>{formatDay(f.day)}</td>
                    <td className={table.td}>{observedText(f)}</td>
                    <td className={table.td}>
                      <AnomalyStatusBadge status={f.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={findings.data.page}
            pageSize={findings.data.pageSize}
            total={findings.data.total}
            onPage={setPage}
          />
        </>
      )}
    </section>
  );
}
