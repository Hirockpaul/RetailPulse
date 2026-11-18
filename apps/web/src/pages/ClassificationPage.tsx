import { useCallback, useState } from 'react';
import {
  type ClassCode,
  type ClassificationSummary,
  fetchClassificationSummary,
  listClassified,
  recalculateClassifications,
} from '../api/classifications';
import { ApiError } from '../api/client';
import { listLocations } from '../api/locations';
import { Badge } from '../components/Badge';
import { Pagination } from '../components/Pagination';
import { Empty, ErrorMessage, Loading } from '../components/Status';
import { field, table } from '../components/table';
import { useUser } from '../lib/auth';
import { formatDateTime, formatDay, formatInt, formatMoney, formatPercent } from '../lib/format';
import { canAccessLocation, canApprove } from '../lib/permissions';
import { href } from '../lib/router';
import { useAsync } from '../lib/useAsync';

const PAGE_SIZE = 25;
const ROWS = ['A', 'B', 'C'] as const;
const COLS = ['X', 'Y', 'Z'] as const;

/** ABC/XYZ: which products carry the value, and how predictable their demand is. */
export function ClassificationPage() {
  const user = useUser();
  const locations = useAsync(listLocations);
  const stores = (locations.status === 'success' ? locations.data.data : []).filter(
    (l) => l.type === 'STORE' && canAccessLocation(user, l.id),
  );
  const [locationId, setLocationId] = useState('');
  const [cls, setCls] = useState<ClassCode | ''>('');
  const [page, setPage] = useState(1);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const summary = useAsync(
    useCallback(() => fetchClassificationSummary(locationId || undefined), [locationId]),
  );
  const items = useAsync(
    useCallback(
      () =>
        listClassified({
          locationId: locationId || undefined,
          cls: cls || undefined,
          page,
          pageSize: PAGE_SIZE,
        }),
      [locationId, cls, page],
    ),
  );

  const recalculate = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const s = await recalculateClassifications();
      setMessage(`Recalculated ${formatInt(s.run?.itemCount ?? 0)} product × scope results.`);
      summary.reload();
      items.reload();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Recalculation failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="classes-heading" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h2 id="classes-heading" className="text-xl font-semibold">
            ABC/XYZ classification
          </h2>
          <p className="max-w-3xl text-sm text-slate-600">
            <strong>ABC</strong>: how much of the stock value a product moves (A = the products
            making up the first 80 % of value). <strong>XYZ</strong>: how predictable its weekly
            sales are (X = steady, Z = erratic or only now and then). Together they suggest how
            closely to manage a product. Advice only — nothing is ordered or changed.
          </p>
        </div>
        <div className="flex items-end gap-3">
          <label className="flex flex-col text-xs text-slate-500">
            Scope
            <select
              className={field}
              value={locationId}
              onChange={(e) => {
                setLocationId(e.target.value);
                setCls('');
                setPage(1);
              }}
            >
              <option value="">Whole network</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} — {s.name}
                </option>
              ))}
            </select>
          </label>
          {canApprove(user) && (
            <button
              type="button"
              disabled={busy}
              onClick={recalculate}
              className={`${field} enabled:hover:bg-slate-100 disabled:opacity-50`}
            >
              {busy ? 'Calculating…' : 'Recalculate'}
            </button>
          )}
        </div>
      </div>
      {message && (
        <p role="status" className="text-sm text-slate-600">
          {message}
        </p>
      )}

      {summary.status === 'loading' && <Loading />}
      {summary.status === 'error' && (
        <ErrorMessage message={summary.error} onRetry={summary.reload} />
      )}
      {summary.status === 'success' && !summary.data.run && (
        <Empty>
          Not calculated yet. An admin or inventory manager can press Recalculate (it also runs once
          a day and in <code>npm run demo</code>).
        </Empty>
      )}
      {summary.status === 'success' && summary.data.run && (
        <Matrix
          s={summary.data}
          selected={cls}
          onSelect={(c) => {
            setCls(c === cls ? '' : c);
            setPage(1);
          }}
        />
      )}

      {summary.status === 'success' && summary.data.run && (
        <div className="space-y-2">
          <h3 className="font-semibold">
            {cls ? `Products in ${cls}` : 'All products'}{' '}
            <span className="text-sm font-normal text-slate-500">(highest value first)</span>
          </h3>
          {items.status === 'loading' && <Loading />}
          {items.status === 'error' && (
            <ErrorMessage message={items.error} onRetry={items.reload} />
          )}
          {items.status === 'success' && items.data.total === 0 && (
            <Empty>No products in this class.</Empty>
          )}
          {items.status === 'success' && items.data.total > 0 && (
            <>
              <div className={table.wrap}>
                <table className={table.table}>
                  <thead className={table.thead}>
                    <tr>
                      <th className={table.th}>Product</th>
                      <th className={table.th}>Class</th>
                      <th className={table.thNum}>Units (52 wk)</th>
                      <th className={table.thNum}>Value at cost</th>
                      <th className={table.thNum}>Share</th>
                      <th className={table.thNum}>Cumulative</th>
                      <th className={table.thNum}>Per week</th>
                      <th className={table.thNum} title="Coefficient of variation of weekly units">
                        Variation
                      </th>
                      <th className={table.thNum} title="Weeks ÷ weeks with a sale">
                        Sells every … weeks
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.data.data.map((r) => (
                      <tr key={r.productId} className={table.row}>
                        <td className={table.td}>
                          <a className={table.link} href={href.product(r.productId)}>
                            {r.sku}
                          </a>{' '}
                          <span className="text-slate-500">{r.productName}</span>
                        </td>
                        <td className={table.td}>
                          <Badge tone={r.cls === 'NEW' ? 'neutral' : 'good'} label={r.cls} />
                        </td>
                        <td className={table.tdNum}>{formatInt(r.units)}</td>
                        <td className={table.tdNum}>{formatMoney(String(r.value))}</td>
                        <td className={table.tdNum}>{formatPercent(r.valueShare)}</td>
                        <td className={table.tdNum}>{formatPercent(r.cumulativeShare)}</td>
                        <td className={table.tdNum}>{r.weeklyMean.toFixed(1)}</td>
                        <td className={table.tdNum}>{formatPercent(r.cv)}</td>
                        <td className={table.tdNum}>{r.adi === null ? '—' : r.adi.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination
                page={items.data.page}
                pageSize={items.data.pageSize}
                total={items.data.total}
                onPage={setPage}
              />
            </>
          )}
        </div>
      )}
    </section>
  );
}

function Matrix({
  s,
  selected,
  onSelect,
}: {
  s: ClassificationSummary;
  selected: ClassCode | '';
  onSelect: (c: ClassCode) => void;
}) {
  const cell = (c: ClassCode) => s.cells.find((x) => x.cls === c);
  const run = s.run!;
  const newCount = cell('NEW')?.count ?? 0;
  const policy = selected && selected !== 'NEW' ? s.policies[selected] : null;
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,26rem)_1fr]">
      <div className="space-y-2">
        <table className="w-full table-fixed border-separate border-spacing-1 text-sm">
          <thead>
            <tr>
              <th className="w-10" />
              {COLS.map((x) => (
                <th key={x} className="font-medium text-slate-600" title={s.meanings.xyz[x]}>
                  {x}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((a) => (
              <tr key={a}>
                <th className="font-medium text-slate-600" title={s.meanings.abc[a]}>
                  {a}
                </th>
                {COLS.map((x) => {
                  const code = `${a}${x}` as ClassCode;
                  const c = cell(code);
                  const active = selected === code;
                  return (
                    <td key={code}>
                      <button
                        type="button"
                        onClick={() => onSelect(code)}
                        aria-pressed={active}
                        className={`w-full rounded border px-2 py-2 text-left focus:outline-2 focus:outline-sky-500 ${
                          active
                            ? 'border-sky-600 bg-sky-50'
                            : c
                              ? 'bg-white hover:bg-slate-50'
                              : 'bg-slate-50 text-slate-400'
                        }`}
                      >
                        <span className="block font-semibold">{code}</span>
                        <span className="block text-xs">{formatInt(c?.count ?? 0)} products</span>
                        <span className="block text-xs text-slate-500">
                          {formatPercent(c?.valueShare ?? 0)} of value
                        </span>
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {newCount > 0 && (
          <button
            type="button"
            onClick={() => onSelect('NEW')}
            className="text-xs text-sky-700 hover:underline"
          >
            + {newCount} products with less than {s.rules.minWeeks} weeks of history (not
            classified)
          </button>
        )}
      </div>
      <div className="space-y-2 text-sm">
        <div className="rounded-lg border bg-white p-4">
          {policy ? (
            <>
              <p className="font-semibold">Suggested policy for {selected}</p>
              <p>{policy}</p>
            </>
          ) : (
            <p className="text-slate-600">
              Click a cell to see its products and the suggested stocking policy.
            </p>
          )}
        </div>
        <p className="text-xs text-slate-500">
          {s.scope.locationCode ? `Store ${s.scope.locationCode}` : 'Whole network'} · sales from{' '}
          {formatDay(run.windowStart)} to {formatDay(run.windowEnd)} ({s.rules.windowWeeks} weeks) ·
          calculated {formatDateTime(run.calculatedAt)}
          {run.triggeredBy ? ` by ${run.triggeredBy}` : ' (daily run)'}.{' '}
          {run.dataLabel !== 'LEDGER' && <Badge tone="warn" label={`${run.dataLabel} data`} />}{' '}
          Value = units × supplier cost. Variation = standard deviation ÷ average of weekly units (X
          ≤ {formatPercent(s.rules.xyz.x)}, Y ≤ {formatPercent(s.rules.xyz.y)}); products that sell
          in fewer than about 3 weeks out of 4 (ADI &gt; {s.rules.intermittentAdi}) are Z. The
          synthetic data has few erratic products, so most of the network is X; single stores show
          more variety.
        </p>
      </div>
    </div>
  );
}
