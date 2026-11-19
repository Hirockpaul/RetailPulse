import type { ZodType } from 'zod';
import { listAlertsQuerySchema } from '../../modules/alerts/alerts.schemas';
import {
  listAnomaliesQuerySchema,
  reviewBodySchema,
} from '../../modules/anomalies/anomalies.schemas';
import { loginBodySchema } from '../../modules/auth/auth.schemas';
import { askAssistantBodySchema } from '../../modules/assistant/assistant.schemas';
import { listProductsQuerySchema } from '../../modules/catalog/catalog.schemas';
import {
  listClassificationsQuerySchema,
  scopeQuerySchema,
} from '../../modules/classifications/classifications.schemas';
import { deadEventsQuerySchema } from '../../modules/events/events.schemas';
import {
  runForecastBodySchema,
  seriesQuerySchema,
} from '../../modules/forecasts/forecasts.schemas';
import {
  adjustmentBodySchema,
  ledgerQuerySchema,
  locationStockQuerySchema,
  receiptBodySchema,
  returnBodySchema,
} from '../../modules/inventory/inventory.schemas';
import { listLocationsQuerySchema } from '../../modules/locations/locations.schemas';
import { modelDecisionSchema } from '../../modules/ml/ml.schemas';
import { listPurchaseOrdersQuerySchema } from '../../modules/purchasing/purchasing.schemas';
import {
  approveBodySchema,
  decisionBodySchema,
  listRecommendationsQuerySchema,
  statusQuerySchema,
} from '../../modules/replenishment/replenishment.schemas';
import {
  generateReportSchema,
  listReportsQuerySchema,
} from '../../modules/reports/reports.schemas';
import {
  createReservationBodySchema,
  listReservationsQuerySchema,
} from '../../modules/reservations/reservations.schemas';
import { createSaleBodySchema } from '../../modules/sales/sales.schemas';
import { createScenarioSchema } from '../../modules/scenarios/scenarios.schemas';
import {
  createTransferBodySchema,
  listTransfersQuerySchema,
} from '../../modules/transfers/transfers.schemas';

export type OpenApiMethod = 'get' | 'post';

/** One source of OpenAPI metadata; body/query objects are the controllers' runtime Zod schemas. */
export interface OpenApiRoute {
  method: OpenApiMethod;
  /** Nest path without the global /api/v1 prefix and without a leading slash. */
  path: string;
  tag: string;
  summary: string;
  description?: string;
  body?: ZodType;
  query?: ZodType;
  idempotencyKey?: boolean;
  public?: boolean;
  /** Metrics is deliberately outside the API prefix. */
  outsideApiPrefix?: boolean;
  responseStatus?: number;
  responseContentType?: 'application/json' | 'text/plain' | 'text/csv' | 'text/html';
}

const get = (path: string, tag: string, summary: string, extra: Partial<OpenApiRoute> = {}) =>
  ({ method: 'get', path, tag, summary, responseStatus: 200, ...extra }) satisfies OpenApiRoute;

const post = (path: string, tag: string, summary: string, extra: Partial<OpenApiRoute> = {}) =>
  ({ method: 'post', path, tag, summary, responseStatus: 201, ...extra }) satisfies OpenApiRoute;

export const OPENAPI_ROUTES: readonly OpenApiRoute[] = [
  get('health', 'System', 'Check API and database health', { public: true }),
  get('metrics', 'System', 'Scrape Prometheus metrics', {
    public: true,
    outsideApiPrefix: true,
    responseContentType: 'text/plain',
  }),
  get('openapi.json', 'Documentation', 'Download the generated OpenAPI document'),
  get('docs', 'Documentation', 'Read the generated API documentation', {
    responseContentType: 'text/html',
  }),

  post('auth/login', 'Authentication', 'Sign in and set the session cookie', {
    public: true,
    body: loginBodySchema,
    responseStatus: 200,
  }),
  post('auth/logout', 'Authentication', 'End the current session if present', {
    public: true,
    responseStatus: 200,
  }),
  get('auth/me', 'Authentication', 'Get the signed-in user'),

  post('assistant/ask', 'Assistant', 'Ask the permission-scoped read-only assistant', {
    body: askAssistantBodySchema,
    responseStatus: 200,
    description:
      'One-shot question over fixed read-only tools. Returns local guidance when AI is off or unavailable.',
  }),

  get('products', 'Catalog', 'List products', { query: listProductsQuerySchema }),
  get('products/:id', 'Catalog', 'Get one product'),
  get('categories', 'Catalog', 'List product categories'),
  get('locations', 'Locations', 'List visible locations', { query: listLocationsQuerySchema }),
  get('locations/:id', 'Locations', 'Get one visible location'),

  get('locations/:id/stock', 'Inventory', 'List current stock at a location', {
    query: locationStockQuerySchema,
  }),
  get('products/:id/stock', 'Inventory', 'List current stock for a product'),
  get('products/:id/ledger', 'Inventory', 'List a product’s append-only stock ledger', {
    query: ledgerQuerySchema,
  }),
  post('receipts', 'Inventory movements', 'Record a stock receipt', {
    body: receiptBodySchema,
    idempotencyKey: true,
  }),
  post('returns', 'Inventory movements', 'Record a sellable or damaged return', {
    body: returnBodySchema,
    idempotencyKey: true,
  }),
  post('adjustments', 'Inventory movements', 'Record a reasoned stock adjustment', {
    body: adjustmentBodySchema,
    idempotencyKey: true,
  }),

  post('sales', 'Sales', 'Record a point-of-sale order', {
    body: createSaleBodySchema,
    idempotencyKey: true,
  }),
  get('sales/:id', 'Sales', 'Get one sales order'),

  post('reservations', 'Reservations', 'Reserve available stock', {
    body: createReservationBodySchema,
    idempotencyKey: true,
  }),
  post('reservations/:id/release', 'Reservations', 'Release an active reservation'),
  get('reservations', 'Reservations', 'List reservations', { query: listReservationsQuerySchema }),
  get('reservations/:id', 'Reservations', 'Get one reservation'),

  post('transfers', 'Transfers', 'Request a stock transfer', {
    body: createTransferBodySchema,
    idempotencyKey: true,
  }),
  get('transfers', 'Transfers', 'List stock transfers', { query: listTransfersQuerySchema }),
  get('transfers/:id', 'Transfers', 'Get one stock transfer'),
  post('transfers/:id/approve', 'Transfers', 'Approve a requested transfer'),
  post('transfers/:id/dispatch', 'Transfers', 'Dispatch an approved transfer'),
  post('transfers/:id/receive', 'Transfers', 'Receive a dispatched transfer'),
  post('transfers/:id/cancel', 'Transfers', 'Cancel a transfer before dispatch'),

  get('ops/events', 'Operations', 'Get outbox worker and backlog status'),
  get('ops/events/dead', 'Operations', 'List dead-letter events', { query: deadEventsQuerySchema }),
  post('ops/events/:id/replay', 'Operations', 'Replay one dead-letter event'),
  get('alerts', 'Alerts', 'List stock alerts', { query: listAlertsQuerySchema }),
  post('alerts/rescan', 'Alerts', 'Re-evaluate stock alerts against current balances'),

  post('forecasts/run', 'Forecasts', 'Start a forecast run', {
    body: runForecastBodySchema,
    responseStatus: 202,
  }),
  get('forecasts/runs/latest', 'Forecasts', 'Get the latest forecast run and metrics'),
  get('forecasts/series', 'Forecasts', 'Get history and forecast for one product and store', {
    query: seriesQuerySchema,
  }),
  get('forecasts/explanation', 'Forecasts', 'Explain the served forecast for one series', {
    query: seriesQuerySchema,
  }),
  post('forecasts/explanation/words', 'Forecasts', 'Reword verified forecast facts', {
    body: seriesQuerySchema,
    responseStatus: 200,
    description:
      'Returns template text when AI is off or unavailable. Never changes forecasts, stock, or orders.',
  }),

  get('purchase-orders', 'Purchasing', 'List purchase orders', {
    query: listPurchaseOrdersQuerySchema,
  }),
  get('purchase-orders/:id', 'Purchasing', 'Get one purchase order'),
  post('purchase-orders/:id/receive', 'Purchasing', 'Receive an approved purchase order'),
  post('purchase-orders/:id/cancel', 'Purchasing', 'Cancel an approved purchase order'),

  post(
    'replenishment/generate',
    'Replenishment',
    'Generate recommendations from the latest forecast',
    {
      responseStatus: 200,
    },
  ),
  get('replenishment/status', 'Replenishment', 'Evaluate replenishment status for one product', {
    query: statusQuerySchema,
  }),
  get('replenishment/recommendations', 'Replenishment', 'List replenishment recommendations', {
    query: listRecommendationsQuerySchema,
  }),
  get('replenishment/recommendations/:id', 'Replenishment', 'Get one recommendation'),
  post(
    'replenishment/recommendations/:id/explanation/words',
    'Replenishment',
    'Explain verified recommendation facts',
    {
      responseStatus: 200,
      description:
        'Returns template text when AI is off or unavailable. Never approves, orders, transfers, or changes stock.',
    },
  ),
  post('replenishment/recommendations/:id/approve', 'Replenishment', 'Approve a recommendation', {
    body: approveBodySchema,
    responseStatus: 200,
  }),
  post('replenishment/recommendations/:id/reject', 'Replenishment', 'Reject a recommendation', {
    body: decisionBodySchema,
    responseStatus: 200,
  }),

  post('scenarios', 'Scenarios', 'Save a what-if scenario', { body: createScenarioSchema }),
  get('scenarios', 'Scenarios', 'List what-if scenarios'),
  get('scenarios/:id', 'Scenarios', 'Get one what-if scenario and its results'),
  post('scenarios/:id/run', 'Scenarios', 'Run a stored scenario without changing stock', {
    responseStatus: 200,
  }),

  post('reports/generate', 'Reports', 'Generate an immutable report snapshot', {
    body: generateReportSchema,
  }),
  get('reports', 'Reports', 'List report snapshots', { query: listReportsQuerySchema }),
  get('reports/:id', 'Reports', 'Get one report snapshot'),
  get('reports/:id/export.csv', 'Reports', 'Download a report as CSV', {
    responseContentType: 'text/csv',
  }),

  get('overview', 'Control Tower', 'Get the scoped Control Tower overview'),
  get('overview/locations', 'Control Tower', 'Get per-location health for the Control Tower'),

  get('anomalies', 'Anomalies', 'List sales and operational anomalies', {
    query: listAnomaliesQuerySchema,
  }),
  get('anomalies/:id', 'Anomalies', 'Get one anomaly and its review history'),
  post('anomalies/:id/explanation/words', 'Anomalies', 'Explain verified anomaly facts', {
    responseStatus: 200,
    description:
      'Returns template text when AI is off or unavailable. Never reviews a finding or changes stock.',
  }),
  post('anomalies/:id/review', 'Anomalies', 'Record an anomaly review decision', {
    body: reviewBodySchema,
    responseStatus: 200,
  }),

  get('classifications', 'ABC/XYZ', 'List classified products', {
    query: listClassificationsQuerySchema,
  }),
  get('classifications/summary', 'ABC/XYZ', 'Get the ABC/XYZ matrix and policies', {
    query: scopeQuerySchema,
  }),
  post('classifications/recalculate', 'ABC/XYZ', 'Recalculate ABC/XYZ classifications', {
    responseStatus: 200,
  }),

  get('suppliers/performance', 'Suppliers', 'List supplier performance'),
  get('suppliers/:id/performance', 'Suppliers', 'Get one supplier’s performance and deliveries'),

  get('ml/models', 'Models', 'List model registry state and activation history'),
  post('ml/models/:id/activate', 'Models', 'Activate an eligible model for future runs', {
    body: modelDecisionSchema,
  }),
  post('ml/models/:id/rollback', 'Models', 'Roll back to the immediately previous active model', {
    body: modelDecisionSchema,
  }),
  get('ml/monitoring', 'Models', 'Get model drift, performance and run health'),
  post('ml/monitoring/run', 'Models', 'Run model monitoring now', { responseStatus: 200 }),
];

export function routeKey(route: Pick<OpenApiRoute, 'method' | 'path'>): string {
  return `${route.method.toUpperCase()} ${route.path}`;
}

export function exposedPath(route: OpenApiRoute): string {
  const path = route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  return route.outsideApiPrefix ? `/${path}` : `/api/v1/${path}`;
}
