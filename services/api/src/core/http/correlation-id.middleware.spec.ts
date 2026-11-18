import { trace } from '@opentelemetry/api';
import type { NextFunction, Request, Response } from 'express';
import { correlationId } from './correlation-id.middleware';

describe('correlationId tracing', () => {
  afterEach(() => jest.restoreAllMocks());

  it('joins the safe correlation ID to the active span and response trace ID', () => {
    const setAttribute = jest.fn();
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue({
      spanContext: () => ({
        traceId: '0123456789abcdef0123456789abcdef',
        spanId: '0123456789abcdef',
        traceFlags: 1,
      }),
      setAttribute,
    } as never);
    const headers: Record<string, string> = {};
    const req = { header: () => 'corr-trace-12345' } as unknown as Request;
    const res = {
      locals: {},
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      },
    } as unknown as Response;
    const next = jest.fn() as NextFunction;

    correlationId(req, res, next);

    expect(setAttribute).toHaveBeenCalledWith('retailpulse.correlation_id', 'corr-trace-12345');
    expect(headers['x-trace-id']).toBe('0123456789abcdef0123456789abcdef');
    expect(next).toHaveBeenCalled();
  });
});
