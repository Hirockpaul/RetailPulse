import { BadRequestException, createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/;

/**
 * Reads and validates the `Idempotency-Key` header: required, 8–100 characters of
 * letters, digits, . _ : -  (a UUID works well). Missing/invalid → 400 VALIDATION_FAILED.
 */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const value = ctx.switchToHttp().getRequest<Request>().header('idempotency-key');
    if (typeof value === 'string' && IDEMPOTENCY_KEY_PATTERN.test(value)) return value;
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'A valid Idempotency-Key header is required.',
      details: [
        {
          path: 'Idempotency-Key',
          message: 'Required: 8–100 characters using letters, digits, . _ : -',
        },
      ],
    });
  },
);
