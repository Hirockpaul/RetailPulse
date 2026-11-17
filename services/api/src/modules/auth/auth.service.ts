import { HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { AuthUser } from '../../core/auth/auth.types';
import { verifyAgainstDummy, verifyPassword } from '../../core/auth/password';
import { SessionService } from '../../core/auth/session.service';
import { AuthRepository } from './auth.repository';
import { LoginThrottle } from './login-throttle';

@Injectable()
export class AuthService {
  private readonly throttle = new LoginThrottle();

  constructor(
    private readonly repo: AuthRepository,
    private readonly sessions: SessionService,
  ) {}

  /**
   * Check credentials and start a session.
   * 401 INVALID_CREDENTIALS is identical for unknown email, wrong password and disabled
   * account, and unknown emails cost the same CPU time (no account enumeration).
   * 429 TOO_MANY_REQUESTS after repeated failures for the same email + IP.
   */
  async login(
    email: string,
    password: string,
    ip: string,
  ): Promise<{ user: AuthUser; token: string; expiresAt: Date }> {
    const key = `${email.toLowerCase()}|${ip}`;
    const wait = this.throttle.retryAfterSeconds(key);
    if (wait > 0) {
      throw new HttpException(
        {
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many failed sign-in attempts. Try again later.',
          details: [{ retryAfterSeconds: wait }],
        },
        429,
      );
    }

    const credentials = await this.repo.findCredentials(email);
    const valid =
      credentials && credentials.isActive
        ? await verifyPassword(password, credentials.passwordHash)
        : await verifyAgainstDummy(password);

    const user = credentials && valid ? await this.sessions.loadUser(credentials.id) : null;
    if (!credentials || !valid || !user) {
      this.throttle.recordFailure(key);
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Incorrect email or password.',
      });
    }

    this.throttle.reset(key);
    const session = await this.sessions.create(user.id);
    await this.repo.touchLastLogin(user.id);
    return { user, ...session };
  }
}
