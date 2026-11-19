import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { CookieOptions } from 'express';
import { readSessionCookie } from '../../core/auth/auth.guard';
import { SESSION_COOKIE } from '../../core/auth/auth.types';
import { Public, READ_ROLES, Roles } from '../../core/auth/roles';
import { SessionService } from '../../core/auth/session.service';
import { ENV, type Env } from '../../core/config/env';
import { Ctx, type RequestContext } from '../../core/http/request-context';
import { ZodValidationPipe } from '../../core/http/zod-validation.pipe';
import { type LoginBody, loginBodySchema } from './auth.schemas';
import { AuthService } from './auth.service';

export function sessionCookieOptions(nodeEnv: Env['NODE_ENV'], expires?: Date): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: nodeEnv === 'production',
    ...(expires ? { expires } : {}),
    path: '/',
  };
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Sets an HttpOnly, SameSite=Strict session cookie (Secure in production). */
  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(loginBodySchema)) body: LoginBody,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, token, expiresAt } = await this.auth.login(
      body.email,
      body.password,
      req.ip ?? 'unknown',
    );
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions(this.env.NODE_ENV, expiresAt));
    return { user };
  }

  /** Always succeeds: ends the session if there is one and clears the cookie. */
  @Public()
  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = readSessionCookie(req.headers.cookie);
    if (token) await this.sessions.destroy(token);
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions(this.env.NODE_ENV));
    return { ok: true };
  }

  @Roles(...READ_ROLES)
  @Get('me')
  me(@Ctx() ctx: RequestContext) {
    return { user: ctx.user };
  }
}
