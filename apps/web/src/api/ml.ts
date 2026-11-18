import { getJson, postJson } from './client';

export type ModelStatus = 'CANDIDATE' | 'ELIGIBLE' | 'ACTIVE' | 'RETIRED' | 'REJECTED';

export interface ModelVersion {
  id: string;
  name: string;
  version: string;
  kind: 'BASELINE' | 'ML' | 'FALLBACK';
  description: string;
  status: ModelStatus;
  params: Record<string, unknown>;
  artifactPath: string | null;
  artifactSha256: string | null;
  artifactSchemaVersion: number | null;
  artifactCreatedAt: string | null;
  trainingStart: string | null;
  trainingEnd: string | null;
  featureConfig: Record<string, unknown>;
  latestRunId: string | null;
  eligibilityReason: string | null;
  evaluatedAt: string | null;
  createdAt: string;
  validationWape: number | null;
  testWape: number | null;
}

export interface ModelActivation {
  id: string;
  action: 'BOOTSTRAP' | 'ACTIVATE' | 'ROLLBACK';
  fromModelId: string | null;
  fromModel: string | null;
  toModelId: string;
  toModel: string;
  actorId: string | null;
  actorName: string | null;
  reason: string;
  createdAt: string;
}

export interface ModelRegistry {
  activationWapeGain: number;
  models: ModelVersion[];
  history: ModelActivation[];
}

export const getModelRegistry = () => getJson<ModelRegistry>('/ml/models');
export const activateModel = (id: string, reason: string) =>
  postJson<ModelRegistry>(`/ml/models/${id}/activate`, { reason });
export const rollbackModel = (id: string, reason: string) =>
  postJson<ModelRegistry>(`/ml/models/${id}/rollback`, { reason });

// ---------------------------------------------------------------- monitoring (V2 3c)

export type DriftStatus = 'INSUFFICIENT_DATA' | 'STABLE' | 'WATCH' | 'DRIFT';
export type PerformanceStatus = 'INSUFFICIENT_DATA' | 'OK' | 'DEGRADED';
export type HealthLevel = 'OK' | 'WARN' | 'ALERT';

export interface MonitoringRun {
  id: string;
  createdAt: string;
  trigger: 'FORECAST_RUN' | 'MANUAL';
  forecastRunId: string | null;
  modelName: string | null;
  trainingEnd: string | null;
  latestDataDay: string | null;
  referenceStart: string | null;
  referenceEnd: string | null;
  currentStart: string | null;
  currentEnd: string | null;
  currentDays: number;
  status: 'SUCCEEDED' | 'FAILED';
  error: string | null;
  dataDrift: DriftStatus | null;
  predictionDrift: DriftStatus | null;
  performance: PerformanceStatus | null;
}

export interface MonitoringResult {
  checkKind: 'FEATURE' | 'STORE_SALES' | 'PREDICTION' | 'PERFORMANCE';
  subject: string;
  locationId: string | null;
  nReference: number | null;
  nCurrent: number | null;
  psi: number | null;
  ksD: number | null;
  ksP: number | null;
  wape: number | null;
  bias: number | null;
  backtestWape: number | null;
  nPoints: number | null;
  nDays: number | null;
  status: DriftStatus | PerformanceStatus;
}

export interface MonitoringOverview {
  health: {
    overall: HealthLevel;
    checks: {
      key: 'FRESHNESS' | 'LATEST_RUN' | 'MONITORING' | 'MODEL_QUALITY';
      level: HealthLevel;
      message: string;
    }[];
  };
  latest: (MonitoringRun & { results: MonitoringResult[] }) | null;
  recent: MonitoringRun[];
  rules: { text: string[]; minCurrentDays: number };
}

export const getMonitoring = () => getJson<MonitoringOverview>('/ml/monitoring');
export const runMonitoring = () => postJson<MonitoringOverview>('/ml/monitoring/run', {});
