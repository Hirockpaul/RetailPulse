import { type FormEvent, useCallback, useState } from 'react';
import { getLocationStock, type StockSort } from '../api/inventory';
import { listLocations } from '../api/locations';
import { StockBadge } from '../components/Badge';
import { Pagination } from '../components/Pagination';
import { AsOf, Empty, ErrorMessage, Loading } from '../components/Status';
import { field, table } from '../components/table';
import { formatDateTime, formatInt } from '../lib/format';
import { href, navigate } from '../lib/router';
import { useUser } from '../lib/auth';
import { canAccessLocation } from '../lib/permissions';
import { useAsync } from '../lib/useAsync';

const PAGE_SIZE = 25;
const SORTS: { value: StockSort; label: string }[] = [
  { value: 'sku:asc', label: 'SKU' },
  { value: 'name:asc', label: 'Name A–Z' },
  { value: 'available:asc', label: 'Available: low → high' },
  { value: 'available:desc', label: 'Available: high → low' },
  { value: 'onHand:desc', label: 'On hand: high → low' },
];

export function StockPage({ locationId }: { locationId?: string }) {
  const user = useUser();
  const locations = useAsync(listLocations);

  if (locations.status === 'loading') return <Loading />;
  if (locations.status === 'error') {
    return <ErrorMessage message={locations.error} onRetry={locations.reload} />;
  }

  // Store managers only see (and can open) their own stores; the API enforces it as well.
  const all = locations.data.data.filter((l) => canAccessLocation(user, l.id));
  const selected = all.find((l) => l.id === locationId) ?? all[0];

  return (
    <section aria-labelledby="stock-heading" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="stock-heading" className="text-xl font-semibold">
          Stock by location
        </h2>
        <label className="flex min-w-0 max-w-full flex-col text-xs text-slate-500">
          Location
          <select
            className={field}
            value={selected?.id ?? ''}
            onChange={(e) => navigate(href.stock(e.target.value))}
          >
            {all.map((l) => (
              <option key={l.id} value={l.id}>
                {l.code} — {l.name} ({l.type === 'STORE' ? 'Store' : 'DC'}, {l.city})
              </option>
            ))}
          </select>
        </label>
      </div>

      {locationId && selected?.id !== locationId && (
        <ErrorMessage message="That location was not found; showing the first location instead." />
      )}
      {!selected && <Empty>No locations exist yet. Run the seed script.</Empty>}
      {/* key: switching location resets search, sort and page. */}
      {selected && <LocationStock key={selected.id} locationId={selected.id} />}
    </section>
  );
}

function LocationStock({ locationId }: { locationId: string }) {
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<StockSort>('sku:asc');
  const [page, setPage] = useState(1);

  const stock = useAsync(
    useCallback(
      () => getLocationStock(locationId, { q, sort, page, pageSize: PAGE_SIZE }),
      [locationId, q, sort, page],
    ),
  );

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    setQ(draft.trim());
    setPage(1);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 max-w-full flex-wrap items-end gap-3">
          <form onSubmit={onSearch} className="flex max-w-full gap-2" role="search">
            <label className="sr-only" htmlFor="stock-search">
              Search by SKU or name
            </label>
            <input
              id="stock-search"
              className={`${field} w-64 min-w-0`}
              placeholder="Search SKU or name"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button type="submit" className={`${field} hover:bg-slate-100`}>
              Search
            </button>
          </form>
          <label className="flex flex-col text-xs text-slate-500">
            Sort
            <select
              className={field}
              value={sort}
              onChange={(e) => {
                setSort(e.target.value as StockSort);
                setPage(1);
              }}
            >
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {stock.status === 'success' && <AsOf iso={stock.data.asOf} />}
      </div>

      {stock.status === 'loading' && <Loading />}
      {stock.status === 'error' && <ErrorMessage message={stock.error} onRetry={stock.reload} />}
      {stock.status === 'success' && stock.data.total === 0 && (
        <Empty>No stock records{q ? ` match “${q}”` : ' at this location'}.</Empty>
      )}
      {stock.status === 'success' && stock.data.total > 0 && (
        <>
          <div className={table.wrap}>
            <table className={table.table}>
              <thead className={table.thead}>
                <tr>
                  <th className={table.th}>SKU</th>
                  <th className={table.th}>Name</th>
                  <th className={table.thNum}>On hand</th>
                  <th className={table.thNum}>Reserved</th>
                  <th className={table.thNum}>Available</th>
                  <th className={table.thNum}>Inbound</th>
                  <th className={table.th}>
                    <span className="sr-only">Status</span>
                  </th>
                  <th className={table.th}>Last change</th>
                </tr>
              </thead>
              <tbody>
                {stock.data.data.map((r) => (
                  <tr key={r.productId} className={table.row}>
                    <td className={table.td}>
                      <a className={table.link} href={href.product(r.productId)}>
                        {r.sku}
                      </a>
                    </td>
                    <td className={table.td}>{r.name}</td>
                    <td className={table.tdNum}>{formatInt(r.onHand)}</td>
                    <td className={table.tdNum}>{formatInt(r.reserved)}</td>
                    <td className={table.tdNum}>{formatInt(r.available)}</td>
                    <td className={table.tdNum}>{r.inbound > 0 ? formatInt(r.inbound) : '—'}</td>
                    <td className={table.td}>
                      <StockBadge available={r.available} packSize={r.packSize} />
                    </td>
                    <td className={table.td}>{formatDateTime(r.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={stock.data.page}
            pageSize={stock.data.pageSize}
            total={stock.data.total}
            onPage={setPage}
          />
        </>
      )}
    </div>
  );
}
