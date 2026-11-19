import { z } from 'zod';
import { paginationSchema, sortSchema, uuidSchema } from '../../core/http/query';

export const ANOMALY_STATUSES = [
  'NEW',
  'INVESTIGATING',
  'CONFIRMED',
  'DISMISSED',
  'RESOLVED',
] as const;
export type AnomalyStatus = (typeof ANOMALY_STATUSES)[number];
export const ANOMALY_SOURCES = ['SALES', 'OPERATIONS'] as const;
export const ANOMALY_KINDS = [
  'SPIKE',
  'DROP',
  'LARGE_WRITE_OFF',
  'FREQUENT_ADJUSTMENTS',
  'HIGH_RETURN_RATE',
] as const;

/**
 * Review steps. A finding starts as NEW (no review row). DISMISSED and RESOLVED are final.
 * The database enforces the same table (trigger in migration 0011).
 */
export const TRANSITIONS: Record<AnomalyStatus, readonly AnomalyStatus[]> = {
  NEW: ['INVESTIGATING', 'CONFIRMED', 'DISMISSED'],
  INVESTIGATING: ['CONFIRMED', 'DISMISSED'],
  CONFIRMED: ['RESOLVED'],
  DISMISSED: [],
  RESOLVED: [],
};

/** A note is required where a decision closes or confirms a case, so others can see why. */
export const NOTE_REQUIRED: readonly AnomalyStatus[] = ['CONFIRMED', 'DISMISSED', 'RESOLVED'];

export const listAnomaliesQuerySchema = paginationSchema.extend({
  /** OPEN = NEW or INVESTIGATING. */
  status: z.enum([...ANOMALY_STATUSES, 'OPEN']).optional(),
  severity: z.enum(['HIGH', 'MEDIUM']).optional(),
  source: z.enum(ANOMALY_SOURCES).optional(),
  kind: z.enum(ANOMALY_KINDS).optional(),
  locationId: uuidSchema.optional(),
  productId: uuidSchema.optional(),
  sort: sortSchema(
    { severity: "f.severity = 'HIGH'", day: 'f.day', score: 'f.score' },
    'severity:desc',
  ),
});
export type ListAnomaliesQuery = z.output<typeof listAnomaliesQuerySchema>;

export const reviewBodySchema = z
  .object({
    status: z.enum(['INVESTIGATING', 'CONFIRMED', 'DISMISSED', 'RESOLVED']),
    note: z.string().trim().max(500).optional(),
  })
  .refine((b) => !NOTE_REQUIRED.includes(b.status) || (b.note ?? '').length >= 3, {
    message: 'Say why (at least 3 characters) when confirming, dismissing or resolving.',
    path: ['note'],
  });
export type ReviewBody = z.output<typeof reviewBodySchema>;

export interface AnomalyFinding {
  id: string;
  source: (typeof ANOMALY_SOURCES)[number];
  kind: (typeof ANOMALY_KINDS)[number];
  severity: 'HIGH' | 'MEDIUM';
  status: AnomalyStatus;
  day: string;
  productId: string;
  sku: string;
  productName: string;
  locationId: string;
  locationCode: string;
  score: number;
  observed: number;
  expected: number;
  explanation: string;
  /** Rule inputs (operational findings); null for sales findings. */
  details: Record<string, unknown> | null;
  rule: string;
  foundAt: Date;
  reviewedAt: Date | null;
}

export interface ReviewEvent {
  fromStatus: AnomalyStatus;
  toStatus: AnomalyStatus;
  note: string | null;
  actor: string;
  at: Date;
}

export interface AnomalyDetail extends AnomalyFinding {
  history: ReviewEvent[];
  /** Steps the caller may take next (empty when final or not allowed for their role/store). */
  nextSteps: AnomalyStatus[];
}

export interface AnomalyWords {
  source: 'ai' | 'template';
  provider?: 'groq' | 'nvidia';
  claims: {
    type: 'fact' | 'prediction' | 'estimate' | 'recommendation' | 'unknown';
    text: string;
  }[];
}
