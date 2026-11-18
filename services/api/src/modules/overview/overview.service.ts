import { Injectable } from '@nestjs/common';
import { accessibleLocationIds } from '../../core/auth/access';
import type { AuthUser } from '../../core/auth/auth.types';
import { EventsService } from '../events/events.service';
import { ForecastsService } from '../forecasts/forecasts.service';
import { summarizePositions } from './overview.calc';
import { OVERVIEW } from './overview.config';
import { OverviewRepository } from './overview.repository';
import type { Overview } from './overview.schemas';

/** One read for the landing page: risks, surplus, work waiting, and how fresh each number is. */
@Injectable()
export class OverviewService {
  constructor(
    private readonly repo: OverviewRepository,
    private readonly forecasts: ForecastsService,
    private readonly events: EventsService,
  ) {}

  async get(user: AuthUser): Promise<Overview> {
    const scope = accessibleLocationIds(user);
    const asOf = new Date();
    const [run, eventStats] = await Promise.all([
      this.forecasts.latestSucceededRun(),
      this.events.stats(),
    ]);
    const [storeCount, positions, recs, alerts, lastMovementAt] = await Promise.all([
      this.repo.storeCount(scope),
      this.repo.positions(run?.id ?? null, OVERVIEW.riskWindowDays, scope),
      this.repo.recommendationCounts(scope),
      this.repo.alertCounts(scope),
      this.repo.lastMovementAt(scope),
    ]);

    return {
      asOf,
      rules: { riskWindowDays: OVERVIEW.riskWindowDays, excessCoverDays: OVERVIEW.excessCoverDays },
      storeCount,
      stock: summarizePositions(positions, OVERVIEW),
      recommendations: {
        pending: recs.pending,
        byRisk: { CRITICAL: recs.critical, HIGH: recs.high },
        byAction: {
          TRANSFER: recs.transfer,
          PURCHASE_ORDER: recs.purchaseOrder,
          REDISTRIBUTE_EXCESS: recs.redistributeExcess,
        },
        lastGeneratedAt: recs.lastGeneratedAt,
      },
      alerts: {
        open: alerts.open,
        byKind: { OUT_OF_STOCK: alerts.outOfStock, LOW_STOCK: alerts.lowStock },
      },
      freshness: {
        lastMovementAt,
        forecast: run
          ? {
              runId: run.id,
              finishedAt: run.finishedAt,
              historyEnd: run.historyEnd,
              dataLabel: run.dataLabel,
              servedModel: run.servedModel,
            }
          : null,
        lastEventProcessedAt: eventStats.events.lastProcessedAt,
        eventsWaiting: eventStats.events.pending + eventStats.events.retrying,
      },
    };
  }
}
