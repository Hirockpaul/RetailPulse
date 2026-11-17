import { useCallback, useState } from 'react';
import { getProduct } from '../api/catalog';
import { getProductLedger, getProductStock } from '../api/inventory';
import { Badge, StockBadge } from '../components/Badge';
import { Pagination } from '../components/Pagination';
import { AsOf, Empty, ErrorMessage, Loading } from '../components/Status';
import { table } from '../components/table';
import { formatDateTime, formatDelta, formatInt, formatMoney, humanize } from '../lib/format';
import { href } from '../lib/router';
import { useAsync } from '../lib/useAsync';

const LEDGER_PAGE_SIZE = 20;

export function ProductDetailPage({ id }: { id: string }) {
  const product = useAsync(useCallback(() => getProduct(id), [id]));

  return (
    <section className="space-y-6">
      <a className={table.link} href={href.products()}>
        ← All products
      </a>

      {product.status === 'loading' && <Loading />}
      {product.status === 'error' && (
        <ErrorMessage
          message={product.httpStatus === 404 ? 'Product not found.' : product.error}
          onRetry={product.httpStatus === 404 ? undefined : product.reload}
        />
      )}
      {product.status === 'success' && (
        <>
          <header className="rounded-lg border bg-white p-5">
            <p className="text-sm text-slate-500">
              {product.data.sku} · {product.data.categoryName}
            </p>
            <h2 className="text-xl font-semibold">{product.data.name}</h2>
            <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
              <Fact label="Unit price" value={formatMoney(product.data.unitPrice)} />
              <Fact label="Pack size" value={formatInt(product.data.packSize)} />
              <Fact label="Network on hand" value={formatInt(product.data.totalOnHand)} />
              <Fact label="Network available" value={formatInt(product.data.totalAvailable)} />
            </dl>
            <div className="mt-4 border-t pt-4 text-sm">
              <h3 className="mb-2 font-medium">Primary supplier</h3>
              {product.data.primarySupplier ? (
                <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
                  <Fact label="Supplier" value={product.data.primarySupplier.name} />
                  <Fact
                    label="Lead time"
                    value={`${product.data.primarySupplier.leadTimeDays} days`}
                  />
                  <Fact
                    label="Min. order qty"
                    value={formatInt(product.data.primarySupplier.minOrderQty)}
                  />
                  <Fact
                    label="Unit cost"
                    value={formatMoney(product.data.primarySupplier.unitCost)}
                  />
                </dl>
              ) : (
                <p className="text-slate-500">No primary supplier configured.</p>
              )}
            </div>
          </header>

          <StockByLocation productId={id} packSize={product.data.packSize} />
          <Ledger productId={id} />
        </>
      )}
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function StockByLocation({ productId, packSize }: { productId: string; packSize: number }) {
  const stock = useAsync(useCallback(() => getProductStock(productId), [productId]));

  return (
    <section aria-labelledby="stock-heading" className="space-y-2">
      <div className="flex items-end justify-between">
        <h3 id="stock-heading" className="font-semibold">
          Stock by location
        </h3>
        {stock.status === 'success' && <AsOf iso={stock.data.asOf} />}
      </div>
      {stock.status === 'loading' && <Loading />}
      {stock.status === 'error' && <ErrorMessage message={stock.error} onRetry={stock.reload} />}
      {stock.status === 'success' && stock.data.data.length === 0 && (
        <Empty>This product is not stocked anywhere yet.</Empty>
      )}
      {stock.status === 'success' && stock.data.data.length > 0 && (
        <div className={table.wrap}>
          <table className={table.table}>
            <thead className={table.thead}>
              <tr>
                <th className={table.th}>Location</th>
                <th className={table.th}>Type</th>
                <th className={table.thNum}>On hand</th>
                <th className={table.thNum}>Reserved</th>
                <th className={table.thNum}>Available</th>
                <th className={table.th}>
                  <span className="sr-only">Status</span>
                </th>
                <th className={table.th}>Last change</th>
              </tr>
            </thead>
            <tbody>
              {stock.data.data.map((r) => (
                <tr key={r.locationId} className={table.row}>
                  <td className={table.td}>
                    <a className={table.link} href={href.stock(r.locationId)}>
                      {r.locationCode}
                    </a>{' '}
                    <span className="text-slate-500">{r.locationName}</span>
                  </td>
                  <td className={table.td}>
                    <Badge label={r.locationType === 'STORE' ? 'Store' : 'DC'} />
                  </td>
                  <td className={table.tdNum}>{formatInt(r.onHand)}</td>
                  <td className={table.tdNum}>{formatInt(r.reserved)}</td>
                  <td className={table.tdNum}>{formatInt(r.available)}</td>
                  <td className={table.td}>
                    <StockBadge available={r.available} packSize={packSize} />
                  </td>
                  <td className={table.td}>{formatDateTime(r.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Ledger({ productId }: { productId: string }) {
  const [page, setPage] = useState(1);
  const ledger = useAsync(
    useCallback(
      () => getProductLedger(productId, { page, pageSize: LEDGER_PAGE_SIZE }),
      [productId, page],
    ),
  );

  return (
    <section aria-labelledby="ledger-heading" className="space-y-2">
      <h3 id="ledger-heading" className="font-semibold">
        Inventory ledger <span className="font-normal text-slate-500">(newest first)</span>
      </h3>
      {ledger.status === 'loading' && <Loading />}
      {ledger.status === 'error' && <ErrorMessage message={ledger.error} onRetry={ledger.reload} />}
      {ledger.status === 'success' && ledger.data.total === 0 && (
        <Empty>No stock movements recorded.</Empty>
      )}
      {ledger.status === 'success' && ledger.data.total > 0 && (
        <>
          <div className={table.wrap}>
            <table className={table.table}>
              <thead className={table.thead}>
                <tr>
                  <th className={table.th}>When</th>
                  <th className={table.th}>Location</th>
                  <th className={table.th}>Movement</th>
                  <th className={table.thNum}>On hand Δ</th>
                  <th className={table.thNum}>Reserved Δ</th>
                  <th className={table.thNum}>On hand after</th>
                  <th className={table.th}>Reason / reference</th>
                </tr>
              </thead>
              <tbody>
                {ledger.data.data.map((e) => (
                  <tr key={e.id} className={table.row}>
                    <td className={table.td}>{formatDateTime(e.occurredAt)}</td>
                    <td className={table.td}>{e.locationCode}</td>
                    <td className={table.td}>
                      <Badge label={humanize(e.movementType)} />
                    </td>
                    <td className={table.tdNum}>{formatDelta(e.onHandDelta)}</td>
                    <td className={table.tdNum}>{formatDelta(e.reservedDelta)}</td>
                    <td className={table.tdNum}>{formatInt(e.onHandAfter)}</td>
                    <td className={table.td}>
                      {e.reason ?? '—'}
                      {e.referenceType && (
                        <span className="text-slate-500">
                          {' '}
                          · {e.referenceType} {e.referenceId}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={ledger.data.page}
            pageSize={ledger.data.pageSize}
            total={ledger.data.total}
            onPage={setPage}
          />
        </>
      )}
    </section>
  );
}
