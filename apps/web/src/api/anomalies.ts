import { getJson, type Page, postJson, qs } from './client';

export type AnomalyStatus = 'NEW' | 'INVESTIGATING' | 'CONFIRMED' | 'DISMISSED' | 'RESOLVED';
export type AnomalyKind =
  'SPIKE' | 'DROP' | 'LARGE_WRITE_OFF' | 'FREQUENT_ADJUSTMENTS' | 'HIGH_RETURN_RATE';

export interface AnomalyFinding {
  id: string;
  source: 'SALES' | 'OPERATIONS';
  kind: AnomalyKind;
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
  details: Record<string, number | string> | null;
  rule: string;
  foundAt: string;
  reviewedAt: string | null;
}

export interface AnomalyDetail extends AnomalyFinding {
  history: {
    fromStatus: AnomalyStatus;
    toStatus: AnomalyStatus;
    note: string | null;
    actor: string;
    at: string;
  }[];
  /** Steps you may take next (decided by the API for your role and store). */
  nextSteps: AnomalyStatus[];
}

export const listAnomalies = (p: {
  status?: AnomalyStatus | 'OPEN';
  severity?: 'HIGH' | 'MEDIUM';
  kind?: AnomalyKind;
  page?: number;
  pageSize?: number;
}) => getJson<Page<AnomalyFinding>>(`/anomalies${qs({ ...p })}`);

export const getAnomaly = (id: string) => getJson<AnomalyDetail>(`/anomalies/${id}`);

export const reviewAnomaly = (id: string, status: AnomalyStatus, note?: string) =>
  postJson<AnomalyDetail>(`/anomalies/${id}/review`, { status, note });
