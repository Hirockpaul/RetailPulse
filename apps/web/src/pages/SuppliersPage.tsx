import { useCallback } from 'react';
import {
  type DeliveryStats,
  getSupplierPerformance,
  listSupplierPerformance,
} from '../api/suppliers';
import { Badge } from '../components/Badge';
import { Empty, ErrorMessage, Loading } from '../components/Status';
import { table } from '../components/table';
import { formatDay, formatInt, formatPercent } from '../lib/format';
import { href } from '../lib/router';
import { useAsync } from '../lib/useAsync';

const lead = (s: DeliveryStats) =>
  s.meanLeadDays === null
    ? '—'
    : `${s.meanLeadDays.toFixed(1)} ± ${(s.stdLeadDays ?? 0).toFixed(1)}`;

function ScoreBadge({ s }: { s: DeliveryStats }) {
  if (s.score === null) return <Badge tone="neutral" label="too few" />;
  return (
    <Badge
      tone={s.score >= 85 ? 'good' : s.score >= 70 ? 'warn' : 'bad'}
      label={String(Math.round(s.score))}
    />
  );
}

/** How reliably each supplier delivers: on time, in full, and how steady its lead time is. */
export function SuppliersPage() {
  const suppliers = useAsync(listSupplierPerformance);
  return (
    <section aria-labelledby="suppliers-heading" className="space-y-4">
      <div className="space-y-1">
        <h2 id="suppliers-heading" className="text-xl font-semibold">
          Supplier performance
        </h2>
        <p className="max-w-3xl text-sm text-slate-600">
          From every delivery: how long orders take, how often they arrive later than promised, and
          how much of each order arrives. The score (0–100) = 50 × on-time rate + 30 × fill rate +
          20 × lead-time steadiness. Statistics only — no prediction. Most history here is{' '}
          <strong>synthetic</strong>; received purchase orders are added as they happen.
        </p>
      </div>
      {suppliers.status === 'loading' && <Loading />}
      {suppliers.status === 'error' && (
        <ErrorMessage message={suppliers.error} onRetry={suppliers.reload} />
      )}
      {suppliers.status === 'success' && suppliers.data.length === 0 && (
        <Empty>No suppliers yet. Run npm run db:seed.</Empty>
      )}
      {suppliers.status === 'success' && suppliers.data.length > 0 && (
        <div className={table.wrap}>
          <table className={table.table}>
            <thead className={table.thead}>
              <tr>
                <th className={table.th}>Supplier</th>
                <th className={table.th}>Score</th>
                <th className={table.thNum}>On time</th>
                <th className={table.thNum}>Late by (avg)</th>
                <th className={table.thNum}>Delivered in full</th>
                <th className={table.thNum}>Lead time, days</th>
                <th className={table.thNum}>Promised</th>
                <th className={table.thNum}>Deliveries</th>
              </tr>
            </thead>
            <tbody>
              {suppliers.data.map((s) => (
                <tr key={s.id} className={table.row}>
                  <td className={table.td}>
                    <a className={table.link} href={href.supplier(s.id)}>
                      {s.name}
                    </a>
                    <span className="block text-xs text-slate-500">
                      {s.code} · {formatInt(s.products)} products
                    </span>
                  </td>
                  <td className={table.td}>
                    <ScoreBadge s={s} />
                  </td>
                  <td className={table.tdNum}>{formatPercent(s.onTimeRate)}</td>
                  <td className={table.tdNum}>
                    {s.avgDaysLate === null ? '—' : `${s.avgDaysLate.toFixed(1)} d`}
                  </td>
                  <td className={table.tdNum}>{formatPercent(s.fillRate)}</td>
                  <td className={table.tdNum}>{lead(s)}</td>
                  <td className={table.tdNum}>
                    {s.meanPromisedDays === null ? '—' : s.meanPromisedDays.toFixed(1)}
                  </td>
                  <td className={table.tdNum}>
                    {formatInt(s.deliveries)}
                    {s.synthetic > 0 && (
                      <span className="block text-xs text-slate-500">
                        {formatInt(s.synthetic)} synthetic
                      </span>
                    )}
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

/** One supplier: summary in words, per product, and the latest deliveries. */
export function SupplierDetailPage({ id }: { id: string }) {
  const detail = useAsync(useCallback(() => getSupplierPerformance(id), [id]));
  return (
    <section className="space-y-4">
      <p className="text-sm">
        <a className={table.link} href={href.suppliers()}>
          ← Supplier performance
        </a>
      </p>
      {detail.status === 'loading' && <Loading />}
      {detail.status === 'error' && <ErrorMessage message={detail.error} onRetry={detail.reload} />}
      {detail.status === 'success' && (
        <>
          <header className="space-y-2 rounded-lg border bg-white p-5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold">{detail.data.name}</h2>
              <ScoreBadge s={detail.data} />
            </div>
            <p>{detail.data.summary}</p>
            <p className="text-xs text-slate-500">
              Score = {detail.data.rules.score}. Fewer than {detail.data.rules.minDeliveries}{' '}
              deliveries are not scored.{' '}
              {detail.data.synthetic > 0 &&
                `${formatInt(detail.data.synthetic)} of ${formatInt(detail.data.deliveries)} deliveries are synthetic history.`}
              {detail.data.lastDelivery && ` Last delivery ${formatDay(detail.data.lastDelivery)}.`}
            </p>
          </header>

          <section aria-labelledby="per-product" className="space-y-2">
            <h3 id="per-product" className="font-semibold">
              Per product
            </h3>
            <div className={table.wrap}>
              <table className={table.table}>
                <thead className={table.thead}>
                  <tr>
                    <th className={table.th}>Product</th>
                    <th className={table.th}>Score</th>
                    <th className={table.thNum}>On time</th>
                    <th className={table.thNum}>In full</th>
                    <th className={table.thNum}>Lead time, days</th>
                    <th className={table.thNum}>Promised</th>
                    <th className={table.thNum}>Deliveries</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.data.productStats.map((p) => (
                    <tr key={p.productId} className={table.row}>
                      <td className={table.td}>
                        <a className={table.link} href={href.product(p.productId)}>
                          {p.sku}
                        </a>{' '}
                        <span className="text-slate-500">{p.productName}</span>
                      </td>
                      <td className={table.td}>
                        <ScoreBadge s={p} />
                      </td>
                      <td className={table.tdNum}>{formatPercent(p.onTimeRate)}</td>
                      <td className={table.tdNum}>{formatPercent(p.fillRate)}</td>
                      <td className={table.tdNum}>{lead(p)}</td>
                      <td className={table.tdNum}>{p.promisedDays ?? '—'}</td>
                      <td className={table.tdNum}>{formatInt(p.deliveries)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-labelledby="recent" className="space-y-2">
            <h3 id="recent" className="font-semibold">
              Latest deliveries
            </h3>
            {detail.data.recent.length === 0 ? (
              <Empty>No deliveries to your stores yet.</Empty>
            ) : (
              <div className={table.wrap}>
                <table className={table.table}>
                  <thead className={table.thead}>
                    <tr>
                      <th className={table.th}>Received</th>
                      <th className={table.th}>Product</th>
                      <th className={table.th}>Store</th>
                      <th className={table.thNum}>Took / promised</th>
                      <th className={table.thNum}>Received / ordered</th>
                      <th className={table.th}>Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.data.recent.map((d, i) => (
                      <tr key={i} className={table.row}>
                        <td className={`${table.td} whitespace-nowrap`}>
                          {formatDay(d.receivedOn)}
                        </td>
                        <td className={table.td}>{d.sku}</td>
                        <td className={`${table.td} whitespace-nowrap`}>{d.locationCode}</td>
                        <td className={table.tdNum}>
                          {d.leadDays} / {d.promisedDays} d{' '}
                          {d.leadDays > d.promisedDays && <Badge tone="warn" label="late" />}
                        </td>
                        <td className={table.tdNum}>
                          {formatInt(d.receivedQty)} / {formatInt(d.orderedQty)}{' '}
                          {d.receivedQty < d.orderedQty && <Badge tone="warn" label="short" />}
                        </td>
                        <td className={table.td}>
                          {d.source === 'SYNTHETIC' ? 'synthetic history' : 'purchase order'}
                        </td>
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
