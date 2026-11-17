import { Injectable } from '@nestjs/common';
import { collectDefaultMetrics, Histogram, Registry } from '@prometheus-io/client';

/**
 * One Prometheus registry per app instance (never the client's global registry, so tests that build
 * several apps don't collide). Modules add their own gauges to `registry` (e.g. the outbox
 * backlog, see modules/events/outbox.metrics.ts).
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  /** Request latency by method, route TEMPLATE (never the raw URL) and status code. */
  readonly httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds, by route template.',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
