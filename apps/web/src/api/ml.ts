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
