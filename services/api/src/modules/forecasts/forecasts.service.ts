import { Injectable, NotFoundException } from '@nestjs/common';
import { assertLocationAccess } from '../../core/auth/access';
import type { AuthUser } from '../../core/auth/auth.types';
import { ForecastClient } from './forecast.client';
import { ForecastsRepository } from './forecasts.repository';
import type {
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
  }> {
    const [latest, current] = await Promise.all([this.repo.latestRun(), this.repo.latestRun(true)]);
    if (!current) return { latest, current, metrics: [], ranges: [] };
    const [metrics, ranges] = await Promise.all([
      this.repo.metrics(current.id),
      this.repo.ranges(current.id),
    ]);
    return { latest, current, metrics, ranges };
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
}
