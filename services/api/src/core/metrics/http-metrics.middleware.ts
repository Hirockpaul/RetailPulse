import type { NextFunction, Request, Response } from 'express';
import type { MetricsService } from './metrics.service';

/**
 * Times every request and records it under its route template (`/api/v1/products/:id`), so
 * ids in URLs never create new label values. Requests that matched no route share one label.
 */
export function httpMetrics(metrics: MetricsService) {
  return (req: Request, res: Response, next: NextFunction) => {
    const end = metrics.httpDuration.startTimer();
    res.on('finish', () => {
      const template = (req.route as { path?: string } | undefined)?.path;
      // Nest answers unknown URLs from a catch-all route ("/api/v1*path"); none of ours use "*".
      const matched = template !== undefined && !template.includes('*');
      end({
        method: req.method,
        route: matched ? `${req.baseUrl}${template}` : 'unmatched',
        status: String(res.statusCode),
      });
    });
    next();
  };
}
