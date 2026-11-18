import { z } from 'zod';

export const MODEL_STATUSES = ['CANDIDATE', 'ELIGIBLE', 'ACTIVE', 'RETIRED', 'REJECTED'] as const;
export type ModelStatus = (typeof MODEL_STATUSES)[number];

export const modelDecisionSchema = z.object({
  reason: z.string().trim().min(5).max(500),
});
export type ModelDecision = z.output<typeof modelDecisionSchema>;

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
  artifactCreatedAt: Date | null;
  trainingStart: string | null;
  trainingEnd: string | null;
  featureConfig: Record<string, unknown>;
  latestRunId: string | null;
  eligibilityReason: string | null;
  evaluatedAt: Date | null;
  createdAt: Date;
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
  createdAt: Date;
}

export interface LockedModel {
  id: string;
  name: string;
  version: string;
  kind: 'BASELINE' | 'ML' | 'FALLBACK';
  status: ModelStatus;
  artifactPath: string | null;
  artifactSha256: string | null;
  artifactSchemaVersion: number | null;
}
