import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type { AuthUser } from './auth.types';

const USER_COLUMNS = `
  u.id, u.email::text AS email, u.display_name AS "displayName", u.role,
  COALESCE(array_agg(a.location_id::text) FILTER (WHERE a.location_id IS NOT NULL), '{}')
    AS "locationIds"`;

/** SQL for sessions and for loading the signed-in user. Only token hashes are stored. */
@Injectable()
export class SessionRepository {
  constructor(private readonly db: DatabaseService) {}

  async insert(idHash: string, userId: string, ttlHours: number): Promise<Date> {
    // Opportunistic cleanup of expired sessions keeps the table small.
    await this.db.query('DELETE FROM sessions WHERE expires_at < now()');
    const { rows } = await this.db.query<{ expiresAt: Date }>(
      `INSERT INTO sessions (id_hash, user_id, expires_at)
       VALUES ($1, $2, now() + make_interval(hours => $3))
       RETURNING expires_at AS "expiresAt"`,
      [idHash, userId, ttlHours],
    );
    return rows[0].expiresAt;
  }

  async findUserBySession(idHash: string): Promise<AuthUser | null> {
    const { rows } = await this.db.query<AuthUser>(
      `SELECT ${USER_COLUMNS}
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN user_store_access a ON a.user_id = u.id
        WHERE s.id_hash = $1 AND s.expires_at > now() AND u.is_active
        GROUP BY u.id`,
      [idHash],
    );
    return rows[0] ?? null;
  }

  async findUserById(id: string): Promise<AuthUser | null> {
    const { rows } = await this.db.query<AuthUser>(
      `SELECT ${USER_COLUMNS}
         FROM users u
         LEFT JOIN user_store_access a ON a.user_id = u.id
        WHERE u.id = $1 AND u.is_active
        GROUP BY u.id`,
      [id],
    );
    return rows[0] ?? null;
  }

  async delete(idHash: string): Promise<void> {
    await this.db.query('DELETE FROM sessions WHERE id_hash = $1', [idHash]);
  }
}
