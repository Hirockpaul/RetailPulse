import { createHash } from 'node:crypto';
import { ConflictException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';

export interface IdempotentResult<T> {
  status: number;
  body: T;
  /** True when this response was stored by an earlier identical request. */
  replayed: boolean;
}

interface StoredKey {
  request_hash: string;
  response_status: number | null;
  response_body: unknown;
}

/**
 * Makes a write safe to retry. `work` runs inside one transaction together with the
 * idempotency-key row:
 *
 *  - first request:  key inserted → work runs → response stored → COMMIT
 *  - retry (same key, same request): stored response returned, work is NOT run again
 *  - same key, different request: 422 IDEMPOTENCY_KEY_REUSED
 *  - concurrent duplicates: the second INSERT waits for the first transaction, then replays it
 *  - work throws: everything (including the key) rolls back, so the client may retry
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly db: DatabaseService) {}

  execute<T>(
    opts: { key: string; endpoint: string; request: unknown },
    work: (client: PoolClient) => Promise<{ status: number; body: T }>,
  ): Promise<IdempotentResult<T>> {
    const { key, endpoint } = opts;
    const hash = createHash('sha256').update(JSON.stringify(opts.request)).digest('hex');

    return this.db.transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO idempotency_keys (key, endpoint, request_hash)
         VALUES ($1, $2, $3)
         ON CONFLICT (key, endpoint) DO NOTHING`,
        [key, endpoint, hash],
      );

      if (inserted.rowCount === 0) {
        const { rows } = await client.query<StoredKey>(
          `SELECT request_hash, response_status, response_body
             FROM idempotency_keys WHERE key = $1 AND endpoint = $2`,
          [key, endpoint],
        );
        const stored = rows[0];
        if (!stored || stored.response_status === null) {
          throw new ConflictException({
            code: 'IDEMPOTENCY_IN_PROGRESS',
            message: 'A request with this Idempotency-Key is still being processed. Retry shortly.',
          });
        }
        if (stored.request_hash !== hash) {
          throw new UnprocessableEntityException({
            code: 'IDEMPOTENCY_KEY_REUSED',
            message: 'This Idempotency-Key was already used with a different request.',
          });
        }
        return { status: stored.response_status, body: stored.response_body as T, replayed: true };
      }

      const result = await work(client);
      await client.query(
        `UPDATE idempotency_keys SET response_status = $3, response_body = $4
          WHERE key = $1 AND endpoint = $2`,
        [key, endpoint, result.status, JSON.stringify(result.body)],
      );
      return { ...result, replayed: false };
    });
  }

  /**
   * Forget finished keys older than `days` (housekeeping). After that a retry with the same key
   * counts as a new request, so `days` must be longer than any client keeps retrying.
   * Deletes in batches so no single statement holds many row locks. Returns the number removed.
   */
  async purgeOlderThan(days: number, batchSize = 5000): Promise<number> {
    let total = 0;
    for (;;) {
      const { rowCount } = await this.db.query(
        `DELETE FROM idempotency_keys WHERE (key, endpoint) IN (
           SELECT key, endpoint FROM idempotency_keys
            WHERE created_at < now() - make_interval(days => $1) AND response_status IS NOT NULL
            LIMIT $2)`,
        [days, batchSize],
      );
      total += rowCount ?? 0;
      if ((rowCount ?? 0) < batchSize) return total;
    }
  }
}
