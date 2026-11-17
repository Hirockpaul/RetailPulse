import { getJson, postJson, qs } from './client';

export interface ForecastRun {
  id: string;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  startedAt: string;
  finishedAt: string | null;
  horizonDays: number;
  /** SYNTHETIC, LEDGER or MIXED: what kind of history the forecast learned from. */
  dataLabel: string | null;
  historyStart: string | null;
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
  /** Fraction: 0.25 = 25%. */
  wape: string | null;
  /** Σ(forecast − actual) ÷ Σ actual: +0.05 = 5% too high. */
  bias: string | null;
  /** Test window: share of actual values inside the 80% / 95% range; mean width in units. */
  intervalCoverage: string | null;
  intervalWidth: string | null;
  interval95Coverage: string | null;
  interval95Width: string | null;
  nPoints: number;
  nSeries: number;
}

/** How the ranges were built for one sales level, and how well they held on the test window. */
export interface RangeGroup {
  level: 80 | 95;
  forecastFrom: number;
  forecastTo: number | null;
  qLow: number;
  qHigh: number;
  testCoverage: number | null;
  testPoints: number;
}

export interface ForecastOverview {
  latest: ForecastRun | null;
  current: ForecastRun | null;
  metrics: ModelMetric[];
  ranges: RangeGroup[];
}

/** The range group a forecast of `perDay` units/day belongs to. */
export const rangeGroupFor = (ranges: RangeGroup[], level: 80 | 95, perDay: number) =>
  ranges.find(
    (g) =>
      g.level === level &&
      perDay >= g.forecastFrom &&
      (g.forecastTo === null || perDay < g.forecastTo),
  );

export interface SeriesForecast {
  run: {
    id: string;
    dataLabel: string | null;
    finishedAt: string | null;
    historyEnd: string | null;
  };
  model: string;
  isFallback: boolean;
  historyDays: number;
  avgDaily28: number;
  stdDaily90: number;
  sigma: number;
  testWape: number | null;
  history: { day: string; units: number }[];
  /** lower/upper: 80% range; lower95/upper95: 95% range (null for older runs). */
  points: {
    day: string;
    horizonDay: number;
    yhat: number;
    lower: number;
    upper: number;
    lower95: number | null;
    upper95: number | null;
  }[];
  ranges: RangeGroup[];
}

export const fetchForecastOverview = () => getJson<ForecastOverview>('/forecasts/runs/latest');
export const startForecastRun = () =>
  postJson<{ runId: string; status: string }>('/forecasts/run', {});
export const fetchSeriesForecast = (productId: string, locationId: string) =>
  getJson<SeriesForecast>(`/forecasts/series${qs({ productId, locationId })}`);
