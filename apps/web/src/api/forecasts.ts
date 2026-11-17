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
  nPoints: number;
  nSeries: number;
}

export interface ForecastOverview {
  latest: ForecastRun | null;
  current: ForecastRun | null;
  metrics: ModelMetric[];
}

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
  points: { day: string; horizonDay: number; yhat: number; lower: number; upper: number }[];
}

export const fetchForecastOverview = () => getJson<ForecastOverview>('/forecasts/runs/latest');
export const startForecastRun = () =>
  postJson<{ runId: string; status: string }>('/forecasts/run', {});
export const fetchSeriesForecast = (productId: string, locationId: string) =>
  getJson<SeriesForecast>(`/forecasts/series${qs({ productId, locationId })}`);
