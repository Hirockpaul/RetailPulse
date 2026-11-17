import type { PoolClient } from 'pg';
import { z } from 'zod';
import { paginationSchema } from '../../core/http/query';

export const INVENTORY_MOVEMENT_RECORDED = 'inventory.movement.recorded';

/** Delivery attempts before an event is parked as DEAD (dead-letter). */
export const MAX_ATTEMPTS = 3;

/** Wait before retry n (1-based): 2 s, 4 s, … Only used between attempts, so MAX_ATTEMPTS - 1 values. */
export const retryDelaySeconds = (attempt: number) => 2 ** attempt;

/** What a producer hands to EventsService.record(). */
export interface NewEvent {
  eventType: string;
  schemaVersion?: number;
  aggregateType: string;
  aggregateId: string;
  /** Business data only: no secrets, no free-text personal data. */
  payload: Record<string, unknown>;
  correlationId?: string;
  occurredAt?: Date;
}

/** An event as consumers see it (the envelope + payload). */
export interface OutboxEvent {
  id: string;
  eventType: string;
  schemaVersion: number;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  correlationId: string | null;
  occurredAt: Date;
  /** Failed attempts so far. */
  attempts: number;
}

/**
 * A handler for some event types. `handle` runs inside the dispatcher's transaction: its
 * database writes commit together with "event handled", or roll back together if it throws.
 * Delivery is at-least-once, but the dispatcher never runs the same consumer twice for one
 * event id, so handlers do not need their own duplicate checks.
 */
export interface EventConsumer {
  /** Stable name; part of the processed_events key. Never rename a live consumer. */
  name: string;
  eventTypes: string[];
  handle(event: OutboxEvent, client: PoolClient): Promise<void>;
}

export const deadEventsQuerySchema = paginationSchema;
export type DeadEventsQuery = z.output<typeof deadEventsQuerySchema>;

export interface EventStats {
  /** Waiting, never attempted. */
  pending: number;
  /** Failed at least once, will be retried. */
  retrying: number;
  processed: number;
  /** Gave up after MAX_ATTEMPTS; needs a person (see replay). */
  dead: number;
  oldestPendingSeconds: number | null;
  lastProcessedAt: Date | null;
}

export interface WorkerState {
  enabled: boolean;
  pollMs: number;
  lastRunAt: Date | null;
  lastError: string | null;
}

export interface DeadEvent {
  id: string;
  eventType: string;
  aggregateId: string;
  attempts: number;
  lastError: string | null;
  occurredAt: Date;
}
