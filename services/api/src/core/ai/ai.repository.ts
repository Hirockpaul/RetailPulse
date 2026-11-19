import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import type { AiErrorType, AiFeature, AiUsage } from './ai.types';

export interface AiReservation {
  requestId: number;
}

@Injectable()
export class AiRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Atomically reserve one of a user's 20 slots in the rolling ten-minute window.
   * The per-user advisory transaction lock prevents simultaneous requests bypassing the count.
   */
  async reserve(
    userId: string,
    feature: AiFeature,
    provider: 'groq' | 'nvidia',
    model: string,
  ): Promise<AiReservation | null> {
    return this.db.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [userId]);
      const { rows } = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM ai_requests
          WHERE user_id = $1
            AND requested_at > now() - interval '10 minutes'
            AND error_type IS DISTINCT FROM 'rate_limit'`,
        [userId],
      );
      if ((rows[0]?.count ?? 0) >= 20) {
        await this.insertCompleted(
          client,
          userId,
          feature,
          provider,
          model,
          'fallback',
          'rate_limit',
        );
        return null;
      }
      const inserted = await client.query<{ id: number }>(
        `INSERT INTO ai_requests (user_id, feature, provider, model)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [userId, feature, provider, model],
      );
      return { requestId: inserted.rows[0].id };
    });
  }

  async complete(
    requestId: number,
    outcome: 'ok' | 'fallback' | 'error',
    durationMs: number,
    usage: AiUsage,
    errorType: AiErrorType | null,
  ): Promise<void> {
    await this.db.query(
      `UPDATE ai_requests
          SET input_tokens = $2, output_tokens = $3, duration_ms = $4,
              outcome = $5, error_type = $6, completed_at = now()
        WHERE id = $1`,
      [requestId, usage.inputTokens, usage.outputTokens, durationMs, outcome, errorType],
    );
  }

  private async insertCompleted(
    client: PoolClient,
    userId: string,
    feature: AiFeature,
    provider: 'groq' | 'nvidia',
    model: string,
    outcome: 'fallback' | 'error',
    errorType: AiErrorType,
  ): Promise<void> {
    await client.query(
      `INSERT INTO ai_requests
         (user_id, feature, provider, model, duration_ms, outcome, error_type, completed_at)
       VALUES ($1, $2, $3, $4, 0, $5, $6, now())`,
      [userId, feature, provider, model, outcome, errorType],
    );
  }
}
