import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type AuthedRequest, type Role, SESSION_COOKIE } from './auth.types';
import { PUBLIC_KEY, ROLES_KEY } from './roles';
import { SessionService } from './session.service';

export function readSessionCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return rest.join('=') || undefined;
  }
  return undefined;
}

/**
 * Global guard: every route needs a valid session unless marked @Public(), and the user's
 * role must be listed in @Roles(...). A route without @Roles() is ADMIN-only.
 * Location-level checks (store managers) happen in services via core/auth/access.ts.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = readSessionCookie(req.headers.cookie);
    const user = token ? await this.sessions.validate(token) : null;
    if (!user) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'Sign in to continue.',
      });
    }
    req.user = user;

    const allowed = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, targets) ?? ['ADMIN'];
    if (!allowed.includes(user.role)) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Your role is not allowed to do this.',
      });
    }
    return true;
  }
}
