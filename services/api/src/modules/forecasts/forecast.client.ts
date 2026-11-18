import {
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ENV, type Env } from '../../core/config/env';

/** Talks to the internal Python forecasting service. Replaced by a fake in tests. */
@Injectable()
export class ForecastClient {
  constructor(@Inject(ENV) private readonly env: Env) {}

  /** Ask the service to start a run in the background (it answers 202 straight away). */
  async startRun(horizonDays?: number): Promise<{ runId: string; status: string }> {
    let res: Response;
    try {
      res = await fetch(`${this.env.FORECAST_URL}/forecast/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(horizonDays === undefined ? {} : { horizonDays }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ServiceUnavailableException({
        code: 'FORECAST_SERVICE_UNAVAILABLE',
        message:
          'The forecasting service is not reachable. Start it with `npm run forecast:serve`.',
      });
    }
    if (res.status === 409) {
      throw new ConflictException({
        code: 'FORECAST_RUN_IN_PROGRESS',
        message: 'A forecast run is already in progress.',
      });
    }
    if (!res.ok) {
      throw new BadGatewayException({
        code: 'FORECAST_SERVICE_ERROR',
        message: `The forecasting service answered ${res.status}.`,
      });
    }
    return (await res.json()) as { runId: string; status: string };
  }

  /** Ask the service to run model monitoring now (V2 3c-2). Synchronous: a few seconds. */
  async runMonitoring(): Promise<MonitoringStarted> {
    let res: Response;
    try {
      res = await fetch(`${this.env.FORECAST_URL}/monitoring/run`, {
        method: 'POST',
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new ServiceUnavailableException({
        code: 'FORECAST_SERVICE_UNAVAILABLE',
        message:
          'The forecasting service is not reachable. Start it with `npm run forecast:serve`.',
      });
    }
    if (!res.ok) {
      throw new BadGatewayException({
        code: 'FORECAST_SERVICE_ERROR',
        message: `The forecasting service answered ${res.status}.`,
      });
    }
    return (await res.json()) as MonitoringStarted;
  }
}

export interface MonitoringStarted {
  monitoringRunId: string;
  status: 'SUCCEEDED' | 'FAILED';
  error: string | null;
}
