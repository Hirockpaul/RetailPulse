import { z } from 'zod';
import { uuidSchema } from '../../core/http/query';

export const runForecastBodySchema = z.object({
  horizonDays: z.number().int().min(1).max(28).optional(),
});
export type RunForecastBody = z.output<typeof runForecastBodySchema>;

export const seriesQuerySchema = z.object({
  productId: uuidSchema,
  locationId: uuidSchema,
});
export type SeriesQuery = z.output<typeof seriesQuerySchema>;

export interface ForecastRun {
  id: string;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  startedAt: Date;
  finishedAt: Date | null;
  horizonDays: number;
  /** SYNTHETIC, LEDGER or MIXED — says what kind of history the forecast learned from. */
  dataLabel: string | null;
  historyStart: string | null;
  /** Last day of data used; forecasts start the day after. */
  historyEnd: string | null;
  validationStart: string | null;
  validationEnd: string | null;
  testStart: string | null;
  testEnd: string | null;
  seriesCount: number | null;
  fallbackCount: number | null;
  servedModel: string | null;
  servedModelKind: 'BASELINE' | 'ML' | 'FALLBACK' | null;
  selectionReason: string | null;
  mlBeatBaseline: boolean | null;
  error: string | null;
}

export interface ModelMetric {
  model: string;
  split: 'validation' | 'test';
  mae: string | null;
  rmse: string | null;
  /** Weighted absolute percentage error as a fraction: 0.25 = 25%. */
  wape: string | null;
  /** Σ(forecast − actual) / Σ actual: +0.05 = 5% over-forecast. */
  bias: string | null;
  /** Test window only: share of actual values inside the 80% / 95% range, and mean width (units). */
  intervalCoverage: string | null;
  intervalWidth: string | null;
  interval95Coverage: string | null;
  interval95Width: string | null;
  nPoints: number;
  nSeries: number;
}

/**
 * How the forecast ranges were built for one range level and forecast-level group, and how well
 * the same method held on the untouched test window (see services/forecasting intervals.py).
 */
export interface RangeGroup {
  level: 80 | 95;
  /** Forecast level of the group in units/day: [forecastFrom, forecastTo); null = no limit. */
  forecastFrom: number;
  forecastTo: number | null;
  /** Added to the forecast to get the lower / upper bound (from measured errors). */
  qLow: number;
  qHigh: number;
  testCoverage: number | null;
  testPoints: number;
}

export interface SeriesForecast {
  run: { id: string; dataLabel: string | null; finishedAt: Date | null; historyEnd: string | null };
  model: string;
  isFallback: boolean;
  historyDays: number;
  avgDaily28: number;
  stdDaily90: number;
  /** Typical forecast error (backtest RMSE) of this series. */
  sigma: number;
  testWape: number | null;
  history: { day: string; units: number }[];
  /** lower/upper = 80% range; lower95/upper95 = 95% range (null for runs before V2 step 1b). */
  points: {
    day: string;
    horizonDay: number;
    yhat: number;
    lower: number;
    upper: number;
    lower95: number | null;
    upper95: number | null;
  }[];
  /** Range calibration of the run, to say how reliable this forecast's range has been. */
  ranges: RangeGroup[];
}
