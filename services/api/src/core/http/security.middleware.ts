import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function firstHeader(value: string | undefined): string | undefined {
  return value?.split(',')[0]?.trim();
}

/**
 * Browser requests with Origin/Fetch Metadata must be same-origin. Requests from service and CLI
 * clients commonly omit both headers and remain supported; authentication and authorization still
 * apply to them normally.
 */
export function isTrustedBrowserRequest(req: Request): boolean {
  if (!UNSAFE_METHODS.has(req.method.toUpperCase())) return true;
  if (req.header('sec-fetch-site') === 'cross-site') return false;

  const origin = req.header('origin');
  if (!origin) return true;

  const host = firstHeader(req.header('x-forwarded-host')) ?? req.header('host');
  const protocol = firstHeader(req.header('x-forwarded-proto')) ?? req.protocol;
  if (!host || !protocol) return false;

  try {
    return new URL(origin).origin === `${protocol}://${host}`;
  } catch {
    return false;
  }
}

/** Security headers and same-origin checks shared by production and test application wiring. */
export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=()');
  res.setHeader('Cache-Control', 'no-store');

  if (req.path === '/api/v1/docs') {
    const nonce = randomBytes(16).toString('base64url');
    res.locals.cspNonce = nonce;
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
        "connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
  }

  if (!isTrustedBrowserRequest(req)) {
    res.status(403).json({
      error: {
        code: 'CROSS_SITE_REQUEST',
        message: 'Cross-site browser requests are not allowed.',
      },
      correlationId: res.locals.correlationId,
    });
    return;
  }

  next();
}
