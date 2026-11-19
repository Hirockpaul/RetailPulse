import { INestApplication } from '@nestjs/common';
import { correlationId } from './core/http/correlation-id.middleware';
import { HttpExceptionFilter } from './core/http/http-exception.filter';
import { securityHeaders } from './core/http/security.middleware';
import { httpMetrics } from './core/metrics/http-metrics.middleware';
import { MetricsService } from './core/metrics/metrics.service';

/** Shared app wiring, used by main.ts and by tests so they exercise the same setup. */
export function configureApp(app: INestApplication): INestApplication {
  // /metrics stays at the root, where Prometheus expects it (and outside the /api proxy).
  app.setGlobalPrefix('api/v1', { exclude: ['metrics'] });
  app.use(httpMetrics(app.get(MetricsService)));
  app.use(correlationId);
  app.use(securityHeaders);
  app.useGlobalFilters(new HttpExceptionFilter());
  app.enableShutdownHooks();
  return app;
}
