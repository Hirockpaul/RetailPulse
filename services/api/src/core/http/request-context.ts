import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthedRequest, AuthUser } from '../auth/auth.types';

/** Who is calling, and which request this is. Passed to services instead of loose arguments. */
export interface RequestContext {
  correlationId?: string;
  user: AuthUser;
}

/** Injects the RequestContext. Only use on routes protected by the AuthGuard (not @Public). */
export const Ctx = createParamDecorator((_data: unknown, ctx: ExecutionContext): RequestContext => {
  const http = ctx.switchToHttp();
  const user = http.getRequest<AuthedRequest>().user;
  if (!user) throw new Error('Ctx() used on a route without authentication.');
  return { correlationId: http.getResponse<Response>().locals.correlationId, user };
});
