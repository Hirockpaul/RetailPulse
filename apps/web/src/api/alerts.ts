import { getJson, type Page, postJson, qs } from './client';

export type AlertKind = 'LOW_STOCK' | 'OUT_OF_STOCK';
export type AlertStatus = 'OPEN' | 'RESOLVED';

export interface Alert {
  id: string;
  kind: AlertKind;
  severity: 'MEDIUM' | 'HIGH';
  status: AlertStatus;
  message: string;
  productId: string;
  sku: string;
  productName: string;
  locationId: string;
  locationCode: string;
  /** The inputs the alert was raised from. */
  details: {
    available?: number;
    onHand?: number;
    reserved?: number;
    packSize?: number;
    rule?: string;
  };
  createdAt: string;
  resolvedAt: string | null;
}

export const listAlerts = (p: {
  status?: AlertStatus;
  kind?: AlertKind;
  page?: number;
  pageSize?: number;
}) => getJson<Page<Alert>>(`/alerts${qs({ ...p })}`);

/** Admins and inventory managers: re-check all low positions against current stock. */
export const rescanAlerts = () => postJson<{ evaluated: number }>('/alerts/rescan', {});

export interface EventStats {
  pending: number;
  retrying: number;
  processed: number;
  dead: number;
  oldestPendingSeconds: number | null;
  lastProcessedAt: string | null;
}

export interface WorkerState {
  enabled: boolean;
  pollMs: number;
  lastRunAt: string | null;
  lastError: string | null;
}

/** Admins and inventory managers only (403 for other roles). */
export const fetchEventStats = () =>
  getJson<{ events: EventStats; worker: WorkerState }>('/ops/events');
