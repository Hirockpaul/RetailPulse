import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

const CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'TOO_MANY_REQUESTS',
};

/** Every error leaves the API as { error: { code, message, details? }, correlationId }. */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const correlationId: string | undefined = res.locals.correlationId;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'An unexpected error occurred.';
    let details: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      const custom =
        typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
      code = typeof custom.code === 'string' ? custom.code : (CODES[status] ?? 'HTTP_ERROR');
      message = typeof body === 'string' ? body : String(custom.message ?? exception.message);
      details = custom.details;
    } else {
      this.logger.error(`Unhandled error [${correlationId}]`, (exception as Error)?.stack);
    }

    res.status(status).json({
      error: details === undefined ? { code, message } : { code, message, details },
      correlationId,
    });
  }
}
