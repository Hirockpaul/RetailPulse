import { useSyncExternalStore } from 'react';

/**
 * Minimal hash router (no dependency): #/products, #/products/:id, #/stock/:locationId, #/transfers, #/transfers/:id, #/health.
 */
export type Route =
  | { name: 'products' }
  | { name: 'product'; id: string }
  | { name: 'stock'; locationId?: string }
  | { name: 'transfers' }
  | { name: 'transfer'; id: string }
  | { name: 'health' }
  | { name: 'notFound' };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts.length === 0 || (parts[0] === 'products' && parts.length === 1)) {
    return { name: 'products' };
  }
  if (parts[0] === 'products' && parts.length === 2) return { name: 'product', id: parts[1] };
  if (parts[0] === 'stock' && parts.length <= 2) return { name: 'stock', locationId: parts[1] };
  if (parts[0] === 'transfers' && parts.length === 1) return { name: 'transfers' };
  if (parts[0] === 'transfers' && parts.length === 2) return { name: 'transfer', id: parts[1] };
  if (parts[0] === 'health' && parts.length === 1) return { name: 'health' };
  return { name: 'notFound' };
}

export const href = {
  products: () => '#/products',
  product: (id: string) => `#/products/${id}`,
  stock: (locationId?: string) => (locationId ? `#/stock/${locationId}` : '#/stock'),
  transfers: () => '#/transfers',
  transfer: (id: string) => `#/transfers/${id}`,
  health: () => '#/health',
};

export function navigate(to: string) {
  window.location.hash = to;
}

function subscribe(onChange: () => void) {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parseRoute(hash);
}
