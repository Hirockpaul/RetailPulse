import { type FormEvent, useCallback, useState } from 'react';
import { listCategories, listProducts, type ProductSort } from '../api/catalog';
import { StockBadge } from '../components/Badge';
import { Pagination } from '../components/Pagination';
import { Empty, ErrorMessage, Loading } from '../components/Status';
import { field, table } from '../components/table';
import { formatInt, formatMoney } from '../lib/format';
import { href } from '../lib/router';
import { useAsync } from '../lib/useAsync';

const PAGE_SIZE = 25;
const SORTS: { value: ProductSort; label: string }[] = [
  { value: 'sku:asc', label: 'SKU' },
  { value: 'name:asc', label: 'Name A–Z' },
  { value: 'price:asc', label: 'Price: low → high' },
  { value: 'price:desc', label: 'Price: high → low' },
  { value: 'available:asc', label: 'Network available: low → high' },
];

export function ProductsPage() {
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [sort, setSort] = useState<ProductSort>('sku:asc');
  const [page, setPage] = useState(1);

  const categories = useAsync(listCategories);
  const products = useAsync(
    useCallback(
      () =>
        listProducts({ q, categoryId: categoryId || undefined, sort, page, pageSize: PAGE_SIZE }),
      [q, categoryId, sort, page],
    ),
  );

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    setQ(draft.trim());
    setPage(1);
  };

  return (
    <section aria-labelledby="products-heading" className="space-y-4">
      <h2 id="products-heading" className="text-xl font-semibold">
        Products
      </h2>

      <div className="flex flex-wrap items-end gap-3">
        <form onSubmit={onSearch} className="flex max-w-full gap-2" role="search">
          <label className="sr-only" htmlFor="product-search">
            Search by SKU or name
          </label>
          <input
            id="product-search"
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
          Category
          <select
            className={field}
            value={categoryId}
            onChange={(e) => {
              setCategoryId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All categories</option>
            {categories.status === 'success' &&
              categories.data.data.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.productCount})
                </option>
              ))}
          </select>
        </label>

        <label className="flex flex-col text-xs text-slate-500">
          Sort
          <select
            className={field}
            value={sort}
            onChange={(e) => {
              setSort(e.target.value as ProductSort);
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

      {products.status === 'loading' && <Loading />}
      {products.status === 'error' && (
        <ErrorMessage message={products.error} onRetry={products.reload} />
      )}
      {products.status === 'success' && products.data.total === 0 && (
        <Empty>No products match{q ? ` “${q}”` : ''}.</Empty>
      )}
      {products.status === 'success' && products.data.total > 0 && (
        <>
          <div className={table.wrap}>
            <table className={table.table}>
              <thead className={table.thead}>
                <tr>
                  <th className={table.th}>SKU</th>
                  <th className={table.th}>Name</th>
                  <th className={table.th}>Category</th>
                  <th className={table.thNum}>Price</th>
                  <th className={table.thNum}>Pack</th>
                  <th className={table.thNum}>Network on hand</th>
                  <th className={table.thNum}>Network available</th>
                  <th className={table.th}>
                    <span className="sr-only">Status</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {products.data.data.map((p) => (
                  <tr key={p.id} className={table.row}>
                    <td className={table.td}>
                      <a className={table.link} href={href.product(p.id)}>
                        {p.sku}
                      </a>
                    </td>
                    <td className={table.td}>{p.name}</td>
                    <td className={table.td}>{p.categoryName}</td>
                    <td className={table.tdNum}>{formatMoney(p.unitPrice)}</td>
                    <td className={table.tdNum}>{p.packSize}</td>
                    <td className={table.tdNum}>{formatInt(p.totalOnHand)}</td>
                    <td className={table.tdNum}>{formatInt(p.totalAvailable)}</td>
                    <td className={table.td}>
                      <StockBadge available={p.totalAvailable} packSize={p.packSize} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={products.data.page}
            pageSize={products.data.pageSize}
            total={products.data.total}
            onPage={setPage}
          />
        </>
      )}
    </section>
  );
}
