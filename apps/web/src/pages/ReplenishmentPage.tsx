import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { fetchForecastOverview, startForecastRun } from '../api/forecasts';
import {
  generateRecommendations,
  listRecommendations,
  type RecommendationAction,
  type RecommendationStatus,
  type Risk,
} from '../api/replenishment';
import { Badge } from '../components/Badge';
import { ForecastAccuracyCard } from '../components/ForecastAccuracyCard';
import { Pagination } from '../components/Pagination';
import {
  actionLabel,
  RecommendationStatusBadge,
  ReviewBadge,
  RiskBadge,
} from '../components/RecommendationBadges';
import { Empty, ErrorMessage, Loading } from '../components/Status';
import { field, table } from '../components/table';
import { useUser } from '../lib/auth';
import { formatDateTime, formatDay, formatDecimal, formatInt } from '../lib/format';
import { canApprove } from '../lib/permissions';
import { href } from '../lib/router';
import { useAsync } from '../lib/useAsync';

const PAGE_SIZE = 25;

export function ReplenishmentPage() {
  const user = useUser();
  const [status, setStatus] = useState<RecommendationStatus | ''>('PENDING');
  const [action, setAction] = useState<RecommendationAction | ''>('');
  const [risk, setRisk] = useState<Risk | ''>('');
  const [review, setReview] = useState<'' | 'true' | 'false'>('');
  const [page, setPage] = useState(1);

  const overview = useAsync(fetchForecastOverview);
  const recs = useAsync(
    useCallback(
      () =>
        listRecommendations({
          status: status || undefined,
          action: action || undefined,
          risk: risk || undefined,
          needsReview: review === '' ? undefined : review === 'true',
          page,
          pageSize: PAGE_SIZE,
        }),
      [status, action, risk, review, page],
    ),
  );

  const [busy, setBusy] = useState<'forecast' | 'recalc' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);
  // Stop polling if the page is left. (Reset on mount: React's dev mode mounts, unmounts and
  // mounts again, which would otherwise leave the flag stuck on "left".)
  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  const recalculate = async () => {
    const r = await generateRecommendations();
    setMessage(
      `${r.created} recommendation${r.created === 1 ? '' : 's'} created from ${formatInt(r.evaluated)} products ` +
        `(${r.byAction.TRANSFER} transfers, ${r.byAction.PURCHASE_ORDER} orders, ${r.byAction.REDISTRIBUTE_EXCESS} excess moves` +
        `${r.fromStoreExcess ? `; ${r.fromStoreExcess} need${r.fromStoreExcess === 1 ? '' : 's'} covered from store excess` : ''}; ${r.skipped.noNeed} products had enough stock` +
        `${r.skipped.noSource ? `, ${r.skipped.noSource} had no source` : ''}). Nothing is ordered until you approve it.`,
    );
    setStatus('PENDING');
    setPage(1);
    recs.reload();
    overview.reload();
  };

  const run = async (kind: 'forecast' | 'recalc') => {
    setBusy(kind);
    setMessage(null);
    setError(null);
    try {
      if (kind === 'forecast') {
        await startForecastRun();
        // The forecast runs in the background service; check on it until it finishes.
        for (;;) {
          await new Promise((r) => setTimeout(r, 2000));
          if (cancelled.current) return;
          const { latest } = await fetchForecastOverview();
          if (latest && latest.status === 'FAILED')
            throw new Error(latest.error ?? 'The forecast run failed.');
          if (latest && latest.status === 'SUCCEEDED') break;
        }
      }
      await recalculate();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unexpected error.');
      if (err instanceof ApiError) setError(err.message);
    } finally {
      if (!cancelled.current) setBusy(null);
    }
  };

  const current = overview.status === 'success' ? overview.data.current : null;

  return (
    <section aria-labelledby="replenishment-heading" className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="replenishment-heading" className="text-xl font-semibold">
            Replenishment
          </h2>
          <p className="max-w-3xl text-sm text-slate-500">
            Suggestions only: nothing is ordered or moved until a manager approves it. Each
            suggestion shows the forecast, the stock position and the calculation behind it.
          </p>
        </div>
        {canApprove(user) && (
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => run('forecast')}
              className="rounded bg-slate-900 px-4 py-1.5 text-sm text-white enabled:hover:bg-slate-700 disabled:opacity-50 focus:outline-2 focus:outline-sky-500"
            >
              {busy === 'forecast' ? 'Forecasting… (about a minute)' : 'Refresh forecasts'}
            </button>
            <button
              type="button"
              disabled={busy !== null || !current}
              onClick={() => run('recalc')}
              title="Recalculate suggestions from the current forecast and current stock"
              className={`${field} enabled:hover:bg-slate-100 disabled:opacity-50`}
            >
              {busy === 'recalc' ? 'Calculating…' : 'Recalculate'}
            </button>
          </div>
        )}
      </div>

      {message && (
        <p role="status" className="text-sm text-emerald-700">
          {message}
        </p>
      )}
      {error && <ErrorMessage message={error} />}

      {overview.status === 'success' &&
        overview.data.latest?.status === 'RUNNING' &&
        busy === null && (
          <p role="status" className="text-sm text-slate-600">
            A forecast run is in progress. Reload in a moment.
          </p>
        )}
      {overview.status === 'success' && !current && (
        <Empty>
          There is no forecast yet.{' '}
          {canApprove(user)
            ? 'Load synthetic history with `npm run forecast:history`, start the forecasting service with `npm run forecast:serve`, then press Refresh forecasts.'
            : 'An admin or inventory manager needs to run one.'}
        </Empty>
      )}
      {overview.status === 'success' && current && (
        <ForecastAccuracyCard overview={overview.data} />
      )}

      <div className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col text-xs text-slate-500">
            Status
            <select
              className={field}
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as RecommendationStatus | '');
                setPage(1);
              }}
            >
              <option value="PENDING">Pending (needs a decision)</option>
              <option value="APPROVED">Approved</option>
              <option value="REJECTED">Rejected</option>
              <option value="EXPIRED">Replaced by newer</option>
              <option value="">All</option>
            </select>
          </label>
          <label className="flex flex-col text-xs text-slate-500">
            Action
            <select
              className={field}
              value={action}
              onChange={(e) => {
                setAction(e.target.value as RecommendationAction | '');
                setPage(1);
              }}
            >
              <option value="">All actions</option>
              <option value="TRANSFER">Transfers</option>
              <option value="PURCHASE_ORDER">Purchase orders</option>
              <option value="REDISTRIBUTE_EXCESS">Excess moves</option>
            </select>
          </label>
          <label className="flex flex-col text-xs text-slate-500">
            Stock-out risk
            <select
              className={field}
              value={risk}
              onChange={(e) => {
                setRisk(e.target.value as Risk | '');
                setPage(1);
              }}
            >
              <option value="">Any</option>
              <option value="CRITICAL">Critical</option>
              <option value="HIGH">High</option>
            </select>
          </label>
          <label className="flex flex-col text-xs text-slate-500">
            Review
            <select
              className={field}
              value={review}
              onChange={(e) => {
                setReview(e.target.value as '' | 'true' | 'false');
                setPage(1);
              }}
            >
              <option value="">Any</option>
              <option value="true">Needs a manual review</option>
              <option value="false">Can be approved as suggested</option>
            </select>
          </label>
        </div>

        {recs.status === 'loading' && <Loading />}
        {recs.status === 'error' && <ErrorMessage message={recs.error} onRetry={recs.reload} />}
        {recs.status === 'success' && recs.data.total === 0 && (
          <Empty>
            {status === 'PENDING'
              ? 'No pending recommendations. Stock looks sufficient for the forecast demand.'
              : 'No recommendations match.'}
          </Empty>
        )}
        {recs.status === 'success' && recs.data.total > 0 && (
          <>
            <div className={table.wrap}>
              <table className={table.table}>
                <thead className={table.thead}>
                  <tr>
                    <th className={table.th}>Risk</th>
                    <th className={table.th}>Product</th>
                    <th className={table.th}>Store</th>
                    <th className={table.th}>Suggested action</th>
                    <th className={table.thNum}>Quantity</th>
                    <th className={table.thNum}>Days of cover</th>
                    <th className={table.th}>Expected stockout</th>
                    <th className={table.th}>Status</th>
                    <th className={table.th}>Generated</th>
                  </tr>
                </thead>
                <tbody>
                  {recs.data.data.map((r) => (
                    <tr key={r.id} className={table.row}>
                      <td className={table.td}>
                        <span className="flex flex-wrap gap-1">
                          <RiskBadge risk={r.risk} />
                          <ReviewBadge reason={r.reviewReason} />
                        </span>
                      </td>
                      <td className={table.td}>
                        <a className={table.link} href={href.recommendation(r.id)}>
                          {r.sku}
                        </a>{' '}
                        <span className="text-slate-500">{r.productName}</span>
                      </td>
                      <td className={table.td}>{r.locationCode}</td>
                      <td className={table.td}>
                        {actionLabel(r)}{' '}
                        {r.action === 'PURCHASE_ORDER' && <Badge tone="neutral" label="order" />}
                        {r.action === 'REDISTRIBUTE_EXCESS' && (
                          <Badge tone="neutral" label="excess" />
                        )}
                      </td>
                      <td className={table.tdNum}>{formatInt(r.quantity)}</td>
                      <td className={table.tdNum}>
                        {r.daysOfCover === null ? '—' : formatDecimal(r.daysOfCover)}
                      </td>
                      <td className={table.td}>
                        {r.expectedStockoutOn ? formatDay(r.expectedStockoutOn) : '—'}
                      </td>
                      <td className={table.td}>
                        <RecommendationStatusBadge status={r.status} />
                      </td>
                      <td className={table.td}>{formatDateTime(r.generatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={recs.data.page}
              pageSize={recs.data.pageSize}
              total={recs.data.total}
              onPage={setPage}
            />
          </>
        )}
      </div>
    </section>
  );
}
