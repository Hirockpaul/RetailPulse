import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';

export interface Credentials {
  id: string;
  passwordHash: string;
  isActive: boolean;
}

/** SQL for the users table (credential lookup only; sessions live in core/auth). */
@Injectable()
export class AuthRepository {
  constructor(private readonly db: DatabaseService) {}

  async findCredentials(email: string): Promise<Credentials | null> {
    const { rows } = await this.db.query<Credentials>(
      `SELECT id, password_hash AS "passwordHash", is_active AS "isActive"
         FROM users WHERE email = $1`,
      [email],
    );
    return rows[0] ?? null;
  }

  async touchLastLogin(userId: string): Promise<void> {
    await this.db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
  }
}
