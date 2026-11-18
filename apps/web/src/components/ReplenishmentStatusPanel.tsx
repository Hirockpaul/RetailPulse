import { useCallback } from 'react';
import { getReplenishmentStatus, type StoreStatus } from '../api/replenishment';
import { formatDay, formatDecimal, formatInt } from '../lib/format';
import { href } from '../lib/router';
import { useAsync } from '../lib/useAsync';
import { Badge } from './Badge';
import { REVIEW_REASON_TEXT, ReviewBadge } from './RecommendationBadges';
import { Empty, ErrorMessage, Loading } from './Status';
import { table } from './table';

const OUTCOME: Record<
  StoreStatus['outcome'],
  { tone: 'neutral' | 'good' | 'warn' | 'bad'; label: string }
> = {
  NO_ACTION_REQUIRED: { tone: 'good', label: 'No action required' },
  NEEDS_STOCK: { tone: 'warn', label: 'Needs stock' },
  NO_SOURCE: { tone: 'bad', label: 'Needs stock, no source' },
  EXCESS: { tone: 'neutral', label: 'Excess stock' },
};

function stockout(s: StoreStatus): string {
  if (s.outOfStockNow) return 'Out of stock now';
  if (!s.expectedStockoutOn) return 'Not within 90 days';
  return `${formatDay(s.expectedStockoutOn)}${s.stockoutBeyondForecast ? ' (estimate)' : ''}`;
}

/**
 * Per store: does this product need anything now? Evaluated on request with the same calculation
 * as the recommendations (V2 2d-1); nothing is stored, decisions happen on the recommendation.
 */
export function ReplenishmentStatusPanel({ productId }: { productId: string }) {
  const status = useAsync(useCallback(() => getReplenishmentStatus(productId), [productId]));

  return (
    <section aria-labelledby="replenishment-status-heading" className="space-y-2">
      <h3 id="replenishment-status-heading" className="font-semibold">
        Replenishment by store
      </h3>
      {status.status === 'loading' && <Loading />}
      {status.status === 'error' && <ErrorMessage message={status.error} onRetry={status.reload} />}
      {status.status === 'success' && status.data.forecastRunId === null && (
        <Empty>No forecast yet, so nothing can be judged. Run a forecast first.</Empty>
      )}
      {status.status === 'success' &&
        status.data.forecastRunId !== null &&
        status.data.stores.length === 0 && <Empty>No store forecast for this product.</Empty>}
      {status.status === 'success' && status.data.stores.length > 0 && (
        <>
          <div className={table.wrap}>
            <table className={table.table}>
              <thead className={table.thead}>
                <tr>
                  <th className={table.th}>Store</th>
                  <th className={table.th}>Now</th>
                  <th className={table.thNum}>Position</th>
                  <th className={table.thNum}>Reorder point</th>
                  <th className={table.th}>Expected stockout</th>
                  <th className={table.th}>Recommendation</th>
                </tr>
              </thead>
              <tbody>
                {status.data.stores.map((s) => (
                  <tr key={s.locationId} className={table.row}>
                    <td className={table.td}>{s.locationCode}</td>
                    <td className={table.td}>
                      <span className="flex flex-wrap gap-1">
                        <Badge tone={OUTCOME[s.outcome].tone} label={OUTCOME[s.outcome].label} />
                        {s.outcome === 'EXCESS' && s.movableExcess !== null && (
                          <Badge tone="neutral" label={`${formatInt(s.movableExcess)} movable`} />
                        )}
                        <ReviewBadge reason={s.outcome === 'NEEDS_STOCK' ? s.reviewReason : null} />
                      </span>
                    </td>
                    <td className={table.tdNum}>{formatInt(s.position)}</td>
                    <td className={table.tdNum}>
                      {s.reorderPoint === null ? '—' : formatDecimal(s.reorderPoint)}
                    </td>
                    <td className={table.td}>{stockout(s)}</td>
                    <td className={table.td}>
                      {s.pending ? (
                        <a className={table.link} href={href.recommendation(s.pending.id)}>
                          Pending:{' '}
                          {s.pending.action === 'TRANSFER'
                            ? 'transfer'
                            : s.pending.action === 'REDISTRIBUTE_EXCESS'
                              ? 'excess move'
                              : 'order'}{' '}
                          {formatInt(s.pending.quantity)} →
                        </a>
                      ) : s.outcome === 'NEEDS_STOCK' ? (
                        <span className="text-slate-600">
                          None yet (would suggest {formatInt(s.suggestedQuantity ?? 0)}); use
                          Recalculate on Replenishment
                        </span>
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {status.data.stores.some((s) => s.outcome === 'NEEDS_STOCK' && s.reviewReason) && (
            <p className="text-xs text-slate-600">
              Needs review:{' '}
              {[...new Set(status.data.stores.map((s) => s.reviewReason).filter(Boolean))]
                .map((r) => REVIEW_REASON_TEXT[r!])
                .join('; ')}
              . A manager sets the quantity when approving.
            </p>
          )}
          <p className="text-xs text-slate-500">
            Checked now against current stock and the latest forecast (position = available +
            inbound; stockout = first day the forecast demand exceeds it). Nothing here orders or
            moves stock.
          </p>
        </>
      )}
    </section>
  );
}
