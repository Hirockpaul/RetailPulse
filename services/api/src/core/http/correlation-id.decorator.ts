import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Response } from 'express';

/** Injects the request's correlation ID (set by the correlation-id middleware). */
export const CorrelationId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined =>
    ctx.switchToHttp().getResponse<Response>().locals.correlationId,
);
