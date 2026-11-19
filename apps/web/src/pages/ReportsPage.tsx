import { type FormEvent, useCallback, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { listLocations } from '../api/locations';
import {
  generateReport,
  fetchReportWords,
  getReport,
  listReports,
  type ReportContent,
  type ReportKind,
  type ReportWords,
  reportCsvUrl,
} from '../api/reports';
import { Badge } from '../components/Badge';
import { Pagination } from '../components/Pagination';
import { Empty, ErrorMessage, Loading } from '../components/Status';
import { field, table } from '../components/table';
import { useUser } from '../lib/auth';
import { formatDateTime, formatDay, formatInt } from '../lib/format';
import { canAccessLocation, isStoreScoped } from '../lib/permissions';
import { href, navigate } from '../lib/router';
import { useAsync } from '../lib/useAsync';

const money = (n: number) =>
  n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const periodText = (kind: ReportKind, start: string, end: string) =>
  kind === 'DAILY' ? formatDay(end) : `${formatDay(start)} – ${formatDay(end)}`;

/** Reports (V2 4c-2): generate a snapshot, and list the ones that exist. */
export function ReportsPage() {
  const [page, setPage] = useState(1);
  const [kind, setKind] = useState<ReportKind | ''>('');
  const reports = useAsync(
    useCallback(() => listReports({ page, kind: kind || undefined }), [page, kind]),
  );

  return (
    <section aria-labelledby="reports-heading" className="space-y-5">
      <div className="space-y-1">
        <h2 id="reports-heading" className="text-xl font-semibold">
          Reports
        </h2>
        <p className="max-w-3xl text-sm text-slate-600">
          A report is a snapshot of one day or one week for the network or one location: sales,
          stock movements, the work done, and the stock figures when it was generated. It never
          changes afterwards. Yesterday’s network report is created every day automatically, and
          last week’s every Monday. Synthetic data.
        </p>
      </div>

      <GenerateForm />

      <section aria-labelledby="list-heading" className="space-y-2">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h3 id="list-heading" className="font-semibold">
            Generated reports
          </h3>
          <label className="flex flex-col text-xs text-slate-500">
            Kind
            <select
              className={field}
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as ReportKind | '');
                setPage(1);
              }}
            >
              <option value="">Daily and weekly</option>
              <option value="DAILY">Daily</option>
              <option value="WEEKLY">Weekly</option>
            </select>
          </label>
        </div>
        {reports.status === 'loading' && <Loading />}
        {reports.status === 'error' && (
          <ErrorMessage message={reports.error} onRetry={reports.reload} />
        )}
        {reports.status === 'success' && reports.data.total === 0 && (
          <Empty>No reports yet: generate one above.</Empty>
        )}
        {reports.status === 'success' && reports.data.total > 0 && (
          <>
            <div className={table.wrap}>
              <table className={table.table}>
                <thead className={table.thead}>
                  <tr>
                    <th className={table.th}>Period</th>
                    <th className={table.th}>Kind</th>
                    <th className={table.th}>Scope</th>
                    <th className={table.th}>Made by</th>
                    <th className={table.th}>Generated</th>
                  </tr>
                </thead>
                <tbody>
                  {reports.data.data.map((r) => (
                    <tr key={r.id} className={table.row}>
                      <td className={table.td}>
                        <a className={table.link} href={href.report(r.id)}>
                          {periodText(r.kind, r.periodStart, r.periodEnd)}
                        </a>
                      </td>
                      <td className={table.td}>{r.kind === 'DAILY' ? 'Daily' : 'Weekly'}</td>
                      <td className={table.td}>{r.locationCode ?? 'Whole network'}</td>
                      <td className={table.td}>
                        {r.trigger === 'SCHEDULED' ? (
                          <Badge tone="neutral" label="Scheduled" />
                        ) : (
                          r.generatedBy
                        )}
                      </td>
                      <td className={table.td}>{formatDateTime(r.generatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={reports.data.page}
              pageSize={reports.data.pageSize}
              total={reports.data.total}
              onPage={setPage}
            />
          </>
        )}
      </section>
    </section>
  );
}

function GenerateForm() {
  const user = useUser();
  const locations = useAsync(listLocations);
  const storeScoped = isStoreScoped(user);
  const [kind, setKind] = useState<ReportKind>('DAILY');
  const [scope, setScope] = useState(''); // '' = network
  const [periodEnd, setPeriodEnd] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choices =
    locations.status === 'success'
      ? locations.data.data.filter((l) => canAccessLocation(user, l.id))
      : [];
  const chosenScope = storeScoped && !scope ? (choices[0]?.id ?? '') : scope;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await generateReport({
        kind,
        locationId: chosenScope || undefined,
        periodEnd: periodEnd || undefined,
      });
      navigate(href.report(r.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unexpected error.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      aria-labelledby="generate-heading"
      className="space-y-3 rounded-lg border bg-white p-4"
    >
      <h3 id="generate-heading" className="font-semibold">
        Generate a report
      </h3>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-xs text-slate-500">
          Kind
          <select
            className={field}
            value={kind}
            onChange={(e) => setKind(e.target.value as ReportKind)}
          >
            <option value="DAILY">Daily (one day)</option>
            <option value="WEEKLY">Weekly (seven days)</option>
          </select>
        </label>
        <label className="flex min-w-0 max-w-full flex-col text-xs text-slate-500">
          Scope
          <select className={field} value={chosenScope} onChange={(e) => setScope(e.target.value)}>
            {!storeScoped && <option value="">Whole network</option>}
            {choices.map((l) => (
              <option key={l.id} value={l.id}>
                {l.code} — {l.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-xs text-slate-500">
          Last day (optional)
          <input
            className={field}
            type="date"
            value={periodEnd}
            onChange={(e) => setPeriodEnd(e.target.value)}
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-slate-900 px-4 py-1.5 text-sm text-white enabled:hover:bg-slate-700 disabled:opacity-50 focus:outline-2 focus:outline-sky-500"
        >
          {busy ? 'Generating…' : 'Generate'}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <p className="text-xs text-slate-500">
        Days are calendar days in UTC. Without a last day the report covers yesterday (the latest
        complete day).
      </p>
    </form>
  );
}

/** One report (V2 4c-2): readable on screen, printable with the browser's "Save as PDF". */
export function ReportDetailPage({ id }: { id: string }) {
  const report = useAsync(useCallback(() => getReport(id), [id]));
  return (
    <section className="space-y-5">
      <a className={`${table.link} print:hidden`} href={href.reports()}>
        ← All reports
      </a>
      {report.status === 'loading' && <Loading />}
      {report.status === 'error' && (
        <ErrorMessage
          message={report.httpStatus === 404 ? 'Report not found.' : report.error}
          onRetry={
            report.httpStatus === 404 || report.httpStatus === 403 ? undefined : report.reload
          }
        />
      )}
      {report.status === 'success' && (
        <ReportView
          content={report.data.content}
          id={report.data.id}
          madeBy={
            report.data.trigger === 'SCHEDULED'
              ? 'the daily schedule'
              : (report.data.generatedBy ?? '—')
          }
        />
      )}
    </section>
  );
}

function Facts({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-slate-500">{k}</dt>
          <dd className="mb-1 font-medium sm:mb-0">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2 rounded-lg border bg-white p-4 print:break-inside-avoid print:border-slate-400">
      <h3 className="font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function ReportView({
  content: c,
  id,
  madeBy,
}: {
  content: ReportContent;
  id: string;
  madeBy: string;
}) {
  const scope = c.scope ? `${c.scope.code} — ${c.scope.name}` : 'Whole network';
  const s = c.stockAtGeneration;
  const n = (v: number | null) => (v === null ? 'needs a forecast' : formatInt(v));
  return (
    <>
      <header className="space-y-2 rounded-lg border bg-white p-5 print:border-slate-400">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm text-slate-500">
              {c.kind === 'DAILY' ? 'Daily' : 'Weekly'} report · {scope}
            </p>
            <h2 className="text-xl font-semibold">
              {periodText(c.kind, c.periodStart, c.periodEnd)}
            </h2>
          </div>
          <div className="flex flex-wrap gap-2 print:hidden">
            <a
              href={reportCsvUrl(id)}
              download
              className="rounded border px-3 py-1.5 text-sm hover:bg-slate-100 focus:outline-2 focus:outline-sky-500"
            >
              Download CSV
            </a>
            <button
              type="button"
              onClick={() => window.print()}
              className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white hover:bg-slate-700 focus:outline-2 focus:outline-sky-500"
            >
              Print / save as PDF
            </button>
          </div>
        </div>
        <Facts
          rows={[
            ['Period', `${formatDay(c.periodStart)} – ${formatDay(c.periodEnd)} (UTC days)`],
            ['Scope', scope],
            ['Generated', `${formatDateTime(c.generatedAt)} by ${madeBy}`],
            ['Data', 'Synthetic demo data'],
          ]}
        />
      </header>

      <Words id={id} />

      <div className="grid gap-4 lg:grid-cols-2 print:grid-cols-2">
        <Block title="Sales in the period">
          <Facts
            rows={[
              ['Units sold', formatInt(c.sales.unitsSold)],
              ['Units returned', formatInt(c.sales.unitsReturned)],
              ['Sales value', `${money(c.sales.salesValueAtPrice)} at current prices`],
            ]}
          />
        </Block>
        <Block title="Stock movements in the period (units)">
          <Facts
            rows={[
              ['Received', formatInt(c.movements.receipts)],
              ['Transferred in', formatInt(c.movements.transfersIn)],
              ['Transferred out', formatInt(c.movements.transfersOut)],
              ['Returned to stock', formatInt(c.movements.returns)],
              [
                'Adjustments',
                `${formatInt(c.movements.adjustmentsNet)} net (${formatInt(c.movements.adjustmentsRemoved)} removed)`,
              ],
            ]}
          />
        </Block>
        <Block title="Work done in the period">
          <Facts
            rows={[
              [
                'Transfers',
                `${formatInt(c.work.transfersRequested)} requested · ${formatInt(c.work.transfersDispatched)} dispatched · ${formatInt(c.work.transfersReceived)} received`,
              ],
              [
                'Purchase orders',
                `${formatInt(c.work.purchaseOrdersCreated)} created · ${formatInt(c.work.purchaseOrdersReceived)} received`,
              ],
              [
                'Recommendations',
                `${formatInt(c.work.recommendationsGenerated)} generated · ${formatInt(c.work.recommendationsApproved)} approved · ${formatInt(c.work.recommendationsRejected)} rejected`,
              ],
              ['Alerts opened', formatInt(c.work.alertsOpened)],
              [
                'Anomalies',
                `${formatInt(c.work.anomaliesFound)} found · ${formatInt(c.work.anomaliesReviewed)} reviewed`,
              ],
            ]}
          />
        </Block>
        <Block title={`Stock when generated (${formatDateTime(s.asOf)})`}>
          <Facts
            rows={[
              ['Units on hand', formatInt(s.onHand)],
              ['Units available', formatInt(s.available)],
              ['Value at cost', money(s.valueAtCost)],
              ['Out of stock', `${formatInt(s.outOfStock)} of ${formatInt(s.positions)} positions`],
              ['Run out within 7 / 14 days', `${n(s.atRisk7)} / ${n(s.atRisk14)}`],
              [
                'Excess (> 60 days)',
                s.excessPositions === null
                  ? 'needs a forecast'
                  : `${formatInt(s.excessPositions)} positions, ${money(s.excessValueAtCost ?? 0)} at cost`,
              ],
            ]}
          />
          <p className="text-xs text-slate-500">
            These are the figures at generation time, not at the end of the period.
          </p>
        </Block>
      </div>

      {c.sales.byStore.length > 0 && (
        <Block title="Sales per store">
          <div className={table.wrap}>
            <table className={table.table}>
              <thead className={table.thead}>
                <tr>
                  <th className={table.th}>Store</th>
                  <th className={table.thNum}>Units sold</th>
                  <th className={table.thNum}>Value at current prices</th>
                </tr>
              </thead>
              <tbody>
                {c.sales.byStore.map((b) => (
                  <tr key={b.locationId} className={table.row}>
                    <td className={table.td}>{b.code}</td>
                    <td className={table.tdNum}>{formatInt(b.unitsSold)}</td>
                    <td className={table.tdNum}>{money(b.valueAtPrice)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Block>
      )}

      <Block title="Top products by units sold">
        {c.sales.topProducts.length === 0 ? (
          <p className="text-sm text-slate-500">Nothing was sold in this period.</p>
        ) : (
          <div className={table.wrap}>
            <table className={table.table}>
              <thead className={table.thead}>
                <tr>
                  <th className={table.th}>Product</th>
                  <th className={table.thNum}>Units sold</th>
                  <th className={table.thNum}>Value at current prices</th>
                </tr>
              </thead>
              <tbody>
                {c.sales.topProducts.map((p) => (
                  <tr key={p.productId} className={table.row}>
                    <td className={table.td}>
                      <span className="font-medium">{p.sku}</span>{' '}
                      <span className="text-slate-500">{p.name}</span>
                    </td>
                    <td className={table.tdNum}>{formatInt(p.unitsSold)}</td>
                    <td className={table.tdNum}>{money(p.valueAtPrice)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Block>

      <p className="text-xs text-slate-500">
        Sales value uses each product’s price when the report was generated, not the price at the
        time of sale. The report is a snapshot: corrections made later appear only in a new report.
        Days are calendar days in UTC.
      </p>
    </>
  );
}

type WordsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'success'; data: ReportWords };

function Words({ id }: { id: string }) {
  const requestNumber = useRef(0);
  const [settled, setSettled] = useState<{ id: string; state: WordsState }>({
    id,
    state: { status: 'idle' },
  });
  const state = settled.id === id ? settled.state : { status: 'idle' as const };

  const load = async () => {
    const request = ++requestNumber.current;
    setSettled({ id, state: { status: 'loading' } });
    try {
      const data = await fetchReportWords(id);
      if (request === requestNumber.current) {
        setSettled({ id, state: { status: 'success', data } });
      }
    } catch (caught) {
      if (request === requestNumber.current) {
        setSettled({
          id,
          state: {
            status: 'error',
            message: caught instanceof ApiError ? caught.message : 'Unexpected error.',
          },
        });
      }
    }
  };

  return (
    <section className="space-y-3 rounded-lg border bg-white p-4 print:break-inside-avoid print:border-slate-400">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold">Report summary in words</h3>
          <p className="text-xs text-slate-500">
            Uses the verified snapshot above. It does not change the report or decide what to do.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={state.status === 'loading'}
          className="rounded bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-800 disabled:cursor-wait disabled:opacity-60 print:hidden"
        >
          {state.status === 'loading' ? 'Summarising…' : 'Summarise in words'}
        </button>
      </div>
      <div aria-live="polite">
        {state.status === 'error' && <ErrorMessage message={state.message} onRetry={load} />}
        {state.status === 'success' && (
          <div className="space-y-2 rounded border border-sky-100 bg-sky-50 p-3 text-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-sky-800">
              {state.data.source === 'ai'
                ? `AI-generated report summary (${state.data.provider === 'nvidia' ? 'NVIDIA' : 'Groq'})`
                : 'Template report summary'}
            </p>
            {state.data.claims.map((claim, index) => (
              <p key={`${claim.type}-${index}`}>
                <span className="mr-2 rounded bg-white px-1.5 py-0.5 text-xs font-medium text-slate-600">
                  {claim.type}
                </span>
                {claim.text}
              </p>
            ))}
            <p className="text-xs text-slate-500">
              {state.data.source === 'ai'
                ? 'AI reworded selected report facts; it did not calculate or change them.'
                : 'This summary was produced locally from the saved report snapshot.'}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
