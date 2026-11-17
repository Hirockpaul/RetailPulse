import { formatInt } from '../lib/format';

interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}

export function Pagination({ page, pageSize, total, onPage }: PaginationProps) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  const button =
    'rounded border px-3 py-1 text-sm enabled:hover:bg-slate-100 disabled:opacity-40 focus:outline-2 focus:outline-sky-500';

  return (
    <nav aria-label="Pagination" className="flex items-center justify-between pt-3 text-sm">
      <span className="text-slate-500">
        {formatInt(from)}–{formatInt(to)} of {formatInt(total)}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={button}
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          Previous
        </button>
        <span className="text-slate-500">
          Page {page} of {pages}
        </span>
        <button
          type="button"
          className={button}
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
        >
          Next
        </button>
      </div>
    </nav>
  );
}
