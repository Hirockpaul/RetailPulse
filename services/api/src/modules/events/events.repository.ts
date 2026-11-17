import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../core/database/database.service';
import { offsetOf } from '../../core/http/query';
import type {
  DeadEvent,
  DeadEventsQuery,
  EventStats,
  NewEvent,
  OutboxEvent,
} from './events.schemas';

/** SQL for outbox_events and processed_events. */
@Injectable()
export class EventsRepository {
  constructor(private readonly db: DatabaseService) {}

  /** Insert inside the producer's transaction — the event exists only if that transaction commits. */
  async insert(client: PoolClient, id: string, e: NewEvent): Promise<void> {
    await client.query(
      `INSERT INTO outbox_events
         (id, event_type, schema_version, aggregate_type, aggregate_id, payload,
          correlation_id, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, now()))`,
      [
        id,
        e.eventType,
        e.schemaVersion ?? 1,
        e.aggregateType,
        e.aggregateId,
        JSON.stringify(e.payload),
        e.correlationId ?? null,
        e.occurredAt ?? null,
      ],
    );
  }

  /**
   * Take the oldest due event and lock it. SKIP LOCKED lets several workers run side by side
   * without ever picking the same event.
   *
   * "Due" = never attempted, OR its retry time has passed. A brand-new event does not wait on
   * the wall clock: system clocks can step backwards (NTP, VM time sync), and an event stamped
   * "now" must not look like it is in the future. Only retry backoff uses the clock.
   */
  async claimNext(client: PoolClient): Promise<OutboxEvent | null> {
    const { rows } = await client.query<OutboxEvent>(
      `SELECT id, event_type AS "eventType", schema_version AS "schemaVersion",
              aggregate_type AS "aggregateType", aggregate_id AS "aggregateId",
              payload, correlation_id AS "correlationId", occurred_at AS "occurredAt", attempts
         FROM outbox_events
        WHERE status = 'PENDING' AND (attempts = 0 OR next_attempt_at <= now())
        ORDER BY seq
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
    );
    return rows[0] ?? null;
  }

  /** True the first time a consumer handles an event; false if it already did (a duplicate). */
  async recordHandled(client: PoolClient, consumer: string, eventId: string): Promise<boolean> {
    const { rowCount } = await client.query(
      `INSERT INTO processed_events (consumer, event_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [consumer, eventId],
    );
    return rowCount === 1;
  }

  async markProcessed(client: PoolClient, id: string): Promise<void> {
    await client.query(
      `UPDATE outbox_events SET status = 'PROCESSED', processed_at = now(), last_error = NULL
        WHERE id = $1`,
      [id],
    );
  }

  async markFailed(
    client: PoolClient,
    id: string,
    error: string,
    dead: boolean,
    retryInSeconds: number,
  ): Promise<void> {
    await client.query(
      `UPDATE outbox_events
          SET attempts = attempts + 1,
              last_error = $2,
              status = CASE WHEN $3::boolean THEN 'DEAD'::outbox_status ELSE status END,
              next_attempt_at = now() + make_interval(secs => $4)
        WHERE id = $1`,
      [id, error, dead, retryInSeconds],
    );
  }

  async stats(): Promise<EventStats> {
    const { rows } = await this.db.query<EventStats>(
      `SELECT COUNT(*) FILTER (WHERE status = 'PENDING' AND attempts = 0)::int AS pending,
              COUNT(*) FILTER (WHERE status = 'PENDING' AND attempts > 0)::int AS retrying,
              COUNT(*) FILTER (WHERE status = 'PROCESSED')::int AS processed,
              COUNT(*) FILTER (WHERE status = 'DEAD')::int AS dead,
              EXTRACT(EPOCH FROM now() - MIN(created_at) FILTER (WHERE status = 'PENDING'))::int
                AS "oldestPendingSeconds",
              MAX(processed_at) AS "lastProcessedAt"
         FROM outbox_events`,
    );
    return rows[0];
  }

  async listDead(q: DeadEventsQuery): Promise<{ rows: DeadEvent[]; total: number }> {
    const [rows, count] = await Promise.all([
      this.db.query<DeadEvent>(
        `SELECT id, event_type AS "eventType", aggregate_id AS "aggregateId", attempts,
                last_error AS "lastError", occurred_at AS "occurredAt"
           FROM outbox_events WHERE status = 'DEAD'
          ORDER BY seq DESC LIMIT $1 OFFSET $2`,
        [q.pageSize, offsetOf(q)],
      ),
      this.db.query<{ total: number }>(
        `SELECT COUNT(*)::int AS total FROM outbox_events WHERE status = 'DEAD'`,
      ),
    ]);
    return { rows: rows.rows, total: count.rows[0].total };
  }

  /**
   * Delete up to `batchSize` PROCESSED events older than `days`, with their handled marks.
   * DEAD and PENDING events are never purged. One statement: the FK from processed_events is
   * checked at its end, after both deletes. Returns the number of events removed.
   */
  async purgeProcessed(days: number, batchSize: number): Promise<number> {
    const { rows } = await this.db.query<{ n: number }>(
      `WITH doomed AS (
         SELECT id FROM outbox_events
          WHERE status = 'PROCESSED' AND processed_at < now() - make_interval(days => $1)
          ORDER BY seq LIMIT $2
          FOR UPDATE SKIP LOCKED),
       marks AS (DELETE FROM processed_events WHERE event_id IN (SELECT id FROM doomed)),
       events AS (DELETE FROM outbox_events WHERE id IN (SELECT id FROM doomed) RETURNING 1)
       SELECT COUNT(*)::int AS n FROM events`,
      [days, batchSize],
    );
    return rows[0].n;
  }

  /** Put a finished or dead event back in the queue. Returns false if it was already pending. */
  async requeue(id: string): Promise<'requeued' | 'already-pending' | 'not-found'> {
    const updated = await this.db.query(
      `UPDATE outbox_events
          SET status = 'PENDING', attempts = 0, next_attempt_at = now(),
              last_error = NULL, processed_at = NULL
        WHERE id = $1 AND status <> 'PENDING'`,
      [id],
    );
    if (updated.rowCount === 1) return 'requeued';
    const exists = await this.db.query('SELECT 1 FROM outbox_events WHERE id = $1', [id]);
    return exists.rowCount === 1 ? 'already-pending' : 'not-found';
  }
}
