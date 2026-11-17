import type { Response } from 'express';
import type { IdempotentResult } from './idempotency.service';

/** Apply the stored/new status to the response and flag replays with a header. */
export function respond<T>(res: Response, result: IdempotentResult<T>): T {
  res.status(result.status);
  if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
  return result.body;
}
