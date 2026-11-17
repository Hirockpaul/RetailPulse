import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { type AuthUser, SESSION_TTL_HOURS } from './auth.types';
import { SessionRepository } from './session.repository';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

@Injectable()
export class SessionService {
  constructor(private readonly repo: SessionRepository) {}

  /** Start a session. The raw token goes into the cookie; only its hash is stored. */
  async create(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = await this.repo.insert(hashToken(token), userId, SESSION_TTL_HOURS);
    return { token, expiresAt };
  }

  /** The user for a valid, unexpired session of an active account — otherwise null. */
  validate(token: string): Promise<AuthUser | null> {
    return this.repo.findUserBySession(hashToken(token));
  }

  destroy(token: string): Promise<void> {
    return this.repo.delete(hashToken(token));
  }

  loadUser(userId: string): Promise<AuthUser | null> {
    return this.repo.findUserById(userId);
  }
}
