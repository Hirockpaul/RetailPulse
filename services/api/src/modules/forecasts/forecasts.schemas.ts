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
  nPoints: number;
  nSeries: number;
}

export interface SeriesForecast {
  run: { id: string; dataLabel: string | null; finishedAt: Date | null; historyEnd: string | null };
  model: string;
  isFallback: boolean;
  historyDays: number;
  avgDaily28: number;
  stdDaily90: number;
  /** Typical forecast error (backtest RMSE); the 80% interval is yhat ± 1.28 × sigma. */
  sigma: number;
  testWape: number | null;
  history: { day: string; units: number }[];
  points: { day: string; horizonDay: number; yhat: number; lower: number; upper: number }[];
}
