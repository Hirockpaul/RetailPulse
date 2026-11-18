import { randomUUID } from 'node:crypto';
import { trace } from '@opentelemetry/api';
import type { NextFunction, Request, Response } from 'express';

export const CORRELATION_HEADER = 'x-correlation-id';
const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Reuse a well-formed incoming correlation ID or create one; echo it on the response. */
export function correlationId(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header(CORRELATION_HEADER);
  const id = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
  res.locals.correlationId = id;
  res.setHeader(CORRELATION_HEADER, id);
  const span = trace.getActiveSpan();
  const traceId = span?.spanContext().traceId;
  if (span && traceId && /^[0-9a-f]{32}$/.test(traceId)) {
    span.setAttribute('retailpulse.correlation_id', id);
    res.setHeader('x-trace-id', traceId);
  }
  next();
}
