import { getJson } from './client';

export interface HealthReport {
  status: 'ok' | 'degraded';
  service: string;
  checkedAt: string;
  uptimeSeconds: number;
  checks: { database: { status: 'up' | 'down'; latencyMs?: number } };
}

/** 503 means "API up, database down" and still returns a report. */
export const fetchHealth = () => getJson<HealthReport>('/health', [503]);
