import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api/client';

export type AsyncState<T> =
  | { status: 'loading' }
  | { status: 'error'; error: string; httpStatus?: number }
  | { status: 'success'; data: T };

interface Settled<T> {
  load: () => Promise<T>;
  nonce: number;
  state: AsyncState<T>;
}

/**
 * Run `load` (memoize it with useCallback) and track loading / error / success.
 * A new `load` identity re-fetches; results from stale requests are ignored.
 */
export function useAsync<T>(load: () => Promise<T>): AsyncState<T> & { reload: () => void } {
  const [nonce, setNonce] = useState(0);
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let active = true;
    load().then(
      (data) => active && setSettled({ load, nonce, state: { status: 'success', data } }),
      (err: unknown) =>
        active &&
        setSettled({
          load,
          nonce,
          state: {
            status: 'error',
            error: err instanceof ApiError ? err.message : 'Unexpected error.',
            httpStatus: err instanceof ApiError ? err.status : undefined,
          },
        }),
    );
    return () => {
      active = false;
    };
  }, [load, nonce]);

  const current: AsyncState<T> =
    settled && settled.load === load && settled.nonce === nonce
      ? settled.state
      : { status: 'loading' };
  return { ...current, reload };
}
