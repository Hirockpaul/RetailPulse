/** Error shape returned by the API: { error: { code, message }, correlationId }. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly correlationId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const BASE = '/api/v1';

/** Paginated list response, matching the API's Page<T>. */
export interface Page<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
}

/** Build a query string, skipping empty values. */
export function qs(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}

async function request<T>(
  path: string,
  init: RequestInit,
  acceptStatuses: number[] = [],
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, init);
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the API.');
  }

  const body = await res.json().catch(() => undefined);
  if (res.ok || acceptStatuses.includes(res.status)) return body as T;

  throw new ApiError(
    res.status,
    body?.error?.code ?? 'HTTP_ERROR',
    body?.error?.message ?? `API responded ${res.status}`,
    body?.correlationId,
  );
}

/**
 * GET a JSON resource. Statuses listed in `acceptStatuses` are returned as data
 * (e.g. health's 503 still carries a valid report); anything else non-2xx throws ApiError.
 */
export function getJson<T>(path: string, acceptStatuses: number[] = []): Promise<T> {
  return request<T>(path, { headers: { Accept: 'application/json' } }, acceptStatuses);
}

/**
 * POST JSON. Stock-changing endpoints need an `Idempotency-Key`: reuse the same key when
 * retrying the same request (it will not be applied twice); use a new key for a new request.
 */
export function postJson<T>(
  path: string,
  body: unknown,
  opts: { idempotencyKey?: string } = {},
): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
}
