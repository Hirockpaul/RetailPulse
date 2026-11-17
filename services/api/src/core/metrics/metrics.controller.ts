import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/roles';
import { MetricsService } from './metrics.service';

/**
 * Prometheus scrape endpoint at /metrics (outside /api/v1, see bootstrap.ts). Public so
 * Prometheus needs no session; it holds counts and latencies only — no personal or business
 * records. The web container only proxies /api, so in the compose demo /metrics is reachable
 * on the internal network only.
 */
@Public()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  async scrape(@Res({ passthrough: true }) res: Response): Promise<string> {
    res.setHeader('Content-Type', this.metrics.contentType);
    return this.metrics.render();
  }
}
