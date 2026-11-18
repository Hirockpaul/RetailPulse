import { useSyncExternalStore } from 'react';

/**
 * Minimal hash router (no dependency): #/ (overview), #/products, #/products/:id, #/stock/:locationId, #/transfers, #/transfers/:id, #/health.
 */
export type Route =
  | { name: 'overview' }
  | { name: 'products' }
  | { name: 'product'; id: string }
  | { name: 'stock'; locationId?: string }
  | { name: 'alerts' }
  | { name: 'anomalies' }
  | { name: 'classification' }
  | { name: 'models' }
  | { name: 'suppliers' }
  | { name: 'supplier'; id: string }
  | { name: 'anomaly'; id: string }
  | { name: 'replenishment' }
  | { name: 'recommendation'; id: string }
  | { name: 'purchaseOrders' }
  | { name: 'purchaseOrder'; id: string }
  | { name: 'transfers' }
  | { name: 'transfer'; id: string }
  | { name: 'health' }
  | { name: 'notFound' };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts.length === 0 || (parts[0] === 'overview' && parts.length === 1)) {
    return { name: 'overview' };
  }
  if (parts[0] === 'products' && parts.length === 1) return { name: 'products' };
  if (parts[0] === 'products' && parts.length === 2) return { name: 'product', id: parts[1] };
  if (parts[0] === 'stock' && parts.length <= 2) return { name: 'stock', locationId: parts[1] };
  if (parts[0] === 'alerts' && parts.length === 1) return { name: 'alerts' };
  if (parts[0] === 'anomalies' && parts.length === 1) return { name: 'anomalies' };
  if (parts[0] === 'classification' && parts.length === 1) return { name: 'classification' };
  if (parts[0] === 'models' && parts.length === 1) return { name: 'models' };
  if (parts[0] === 'suppliers' && parts.length === 1) return { name: 'suppliers' };
  if (parts[0] === 'suppliers' && parts.length === 2) return { name: 'supplier', id: parts[1] };
  if (parts[0] === 'anomalies' && parts.length === 2) return { name: 'anomaly', id: parts[1] };
  if (parts[0] === 'replenishment' && parts.length === 1) return { name: 'replenishment' };
  if (parts[0] === 'replenishment' && parts.length === 2)
    return { name: 'recommendation', id: parts[1] };
  if (parts[0] === 'purchase-orders' && parts.length === 1) return { name: 'purchaseOrders' };
  if (parts[0] === 'purchase-orders' && parts.length === 2)
    return { name: 'purchaseOrder', id: parts[1] };
  if (parts[0] === 'transfers' && parts.length === 1) return { name: 'transfers' };
  if (parts[0] === 'transfers' && parts.length === 2) return { name: 'transfer', id: parts[1] };
  if (parts[0] === 'health' && parts.length === 1) return { name: 'health' };
  return { name: 'notFound' };
}

export const href = {
  overview: () => '#/',
  products: () => '#/products',
  product: (id: string) => `#/products/${id}`,
  stock: (locationId?: string) => (locationId ? `#/stock/${locationId}` : '#/stock'),
  alerts: () => '#/alerts',
  anomalies: () => '#/anomalies',
  classification: () => '#/classification',
  models: () => '#/models',
  suppliers: () => '#/suppliers',
  supplier: (id: string) => `#/suppliers/${id}`,
  anomaly: (id: string) => `#/anomalies/${id}`,
  replenishment: () => '#/replenishment',
  recommendation: (id: string) => `#/replenishment/${id}`,
  purchaseOrders: () => '#/purchase-orders',
  purchaseOrder: (id: string) => `#/purchase-orders/${id}`,
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
