import type { Context } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type Span,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const SECRET_ATTRIBUTES = [
  'db.statement',
  'db.query.text',
  'http.request.body',
  'http.response.body',
];
const URL_ATTRIBUTES = ['url.full', 'url.query', 'http.url', 'http.target'];

/** Keep parameter names useful for diagnostics without exporting their values. */
export function redactQueryValues(value: string): string {
  const question = value.indexOf('?');
  const isQueryOnly = question === -1 && !value.startsWith('/') && !value.includes('://');
  const prefix = isQueryOnly ? '' : question === -1 ? value : value.slice(0, question + 1);
  const rawQuery = isQueryOnly ? value : question === -1 ? '' : value.slice(question + 1);
  if (!rawQuery) return value;
  const redacted = new URLSearchParams(rawQuery);
  for (const key of [...redacted.keys()]) redacted.set(key, 'REDACTED');
  return `${prefix}${redacted.toString()}`;
}

/** Runs before export so query values and SQL text cannot leave the process. */
export class SensitiveAttributeProcessor implements SpanProcessor {
  onStart(span: Span, parentContext: Context): void {
    void span;
    void parentContext;
  }

  onEnding(span: Span): void {
    const attributes = span.attributes as Record<string, unknown>;
    for (const key of SECRET_ATTRIBUTES) delete attributes[key];
    for (const key of URL_ATTRIBUTES) {
      const value = attributes[key];
      if (typeof value === 'string') span.setAttribute(key, redactQueryValues(value));
    }
  }

  onEnd(span: ReadableSpan): void {
    void span;
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export function tracesEndpoint(value: string | undefined): string | null {
  const endpoint = value?.trim().replace(/\/$/, '');
  if (!endpoint) return null;
  return endpoint.endsWith('/v1/traces') ? endpoint : `${endpoint}/v1/traces`;
}

/** Optional by design: no endpoint means no SDK, exporter, timers or network calls. */
export function startTracing(source: NodeJS.ProcessEnv = process.env): NodeSDK | null {
  const endpoint = tracesEndpoint(source.OTEL_EXPORTER_OTLP_ENDPOINT);
  if (!endpoint) return null;

  const exporter = new OTLPTraceExporter({ url: endpoint });
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'retailpulse-api' }),
    spanProcessors: [new SensitiveAttributeProcessor(), new BatchSpanProcessor({ exporter })],
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (request) => request.url === '/metrics',
      }),
      new ExpressInstrumentation(),
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
    ],
  });
  sdk.start();
  return sdk;
}
