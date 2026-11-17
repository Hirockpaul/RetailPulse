import { Injectable, NotFoundException } from '@nestjs/common';
import { assertLocationAccess } from '../../core/auth/access';
import type { AuthUser } from '../../core/auth/auth.types';
import { ForecastClient } from './forecast.client';
import { describeFactor, featureLabel } from './forecasts.explain';
import { ForecastsRepository } from './forecasts.repository';
import type {
  ForecastExplanation,
  ForecastRun,
  ModelMetric,
  RangeGroup,
  RunForecastBody,
  SeriesForecast,
  SeriesQuery,
} from './forecasts.schemas';

const HISTORY_DAYS_SHOWN = 56;

@Injectable()
export class ForecastsService {
  constructor(
    private readonly repo: ForecastsRepository,
    private readonly client: ForecastClient,
  ) {}

  /** Start a forecast run in the Python service. It only writes forecast data, never stock. */
  startRun(body: RunForecastBody) {
    return this.client.startRun(body.horizonDays);
  }

  /**
   * `latest` is the newest run of any status (to show progress or a failure);
   * `current` is the newest SUCCEEDED run with its accuracy numbers (what recommendations use).
   */
  async overview(): Promise<{
    latest: ForecastRun | null;
    current: ForecastRun | null;
    metrics: ModelMetric[];
    ranges: RangeGroup[];
    importance: ForecastExplanation['globalImportance'];
  }> {
    const [latest, current] = await Promise.all([this.repo.latestRun(), this.repo.latestRun(true)]);
    if (!current) return { latest, current, metrics: [], ranges: [], importance: [] };
    const [metrics, ranges, importance] = await Promise.all([
      this.repo.metrics(current.id),
      this.repo.ranges(current.id),
      this.repo.featureImportance(current.id),
    ]);
    return {
      latest,
      current,
      metrics,
      ranges,
      importance: importance.map((i) => ({ ...i, label: featureLabel(i.feature) })),
    };
  }

  /** For other modules: the newest successful run, or null. */
  latestSucceededRun(): Promise<ForecastRun | null> {
    return this.repo.latestRun(true);
  }

  async series(query: SeriesQuery, user: AuthUser): Promise<SeriesForecast> {
    assertLocationAccess(user, query.locationId);
    const run = await this.repo.latestRun(true);
    const series = run
      ? await this.repo.series(run.id, query.productId, query.locationId, HISTORY_DAYS_SHOWN)
      : null;
    if (!run || !series) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'No forecast exists for that product at that store yet.',
      });
    }
    return {
      run: {
        id: run.id,
        dataLabel: run.dataLabel,
        finishedAt: run.finishedAt,
        historyEnd: run.historyEnd,
      },
      ...series,
      ranges: await this.repo.ranges(run.id),
    };
  }

  /** Why the first forecast day (the day after the history ends) for one product at one store is what it is (store-scoped). */
  async explanation(query: SeriesQuery, user: AuthUser): Promise<ForecastExplanation> {
    assertLocationAccess(user, query.locationId);
    const run = await this.repo.latestRun(true);
    const found = run
      ? await this.repo.explanation(run.id, query.productId, query.locationId)
      : null;
    if (!run || !found || found.isFallback === null) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'No forecast exists for that product at that store yet.',
      });
    }
    const importance = await this.repo.featureImportance(run.id);
    let status: ForecastExplanation['status'];
    if (found.row) status = 'OK';
    else if (found.isFallback) status = 'FALLBACK';
    else if (run.explanationStatus === 'NOT_ML' || run.explanationStatus === 'FAILED_CHECK')
      status = run.explanationStatus;
    else status = 'NOT_AVAILABLE'; // run made before explanations existed
    const ctx = { categoryName: found.categoryName, locationCode: found.locationCode };
    return {
      run: {
        id: run.id,
        dataLabel: run.dataLabel,
        finishedAt: run.finishedAt,
        historyEnd: run.historyEnd,
      },
      servedModel: run.servedModel,
      status,
      explanation: found.row
        ? {
            horizonDay: found.row.horizonDay,
            targetDay: found.row.targetDay,
            startingPoint: Math.exp(found.row.baseLog),
            forecast: found.row.forecast,
            factors: found.row.contributions.map((c) => describeFactor(c, ctx)),
          }
        : null,
      globalImportance: importance.map((i) => ({ ...i, label: featureLabel(i.feature) })),
    };
  }
}
