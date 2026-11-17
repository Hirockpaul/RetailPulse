import { INestApplication } from '@nestjs/common';
import { correlationId } from './core/http/correlation-id.middleware';
import { HttpExceptionFilter } from './core/http/http-exception.filter';

/** Shared app wiring, used by main.ts and by tests so they exercise the same setup. */
export function configureApp(app: INestApplication): INestApplication {
  app.setGlobalPrefix('api/v1');
  app.use(correlationId);
  app.useGlobalFilters(new HttpExceptionFilter());
  app.enableShutdownHooks();
  return app;
}
