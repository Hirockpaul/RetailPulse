import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { DatabaseService } from '../../core/database/database.service';

export interface HealthReport {
  status: 'ok' | 'degraded';
  service: 'retailpulse-api';
  checkedAt: string;
  uptimeSeconds: number;
  checks: { database: { status: 'up' | 'down'; latencyMs?: number } };
}

@Controller('health')
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  async check(@Res({ passthrough: true }) res: Response): Promise<HealthReport> {
    let database: HealthReport['checks']['database'];
    try {
      database = { status: 'up', latencyMs: await this.db.ping() };
    } catch {
      database = { status: 'down' };
    }

    const ok = database.status === 'up';
    res.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return {
      status: ok ? 'ok' : 'degraded',
      service: 'retailpulse-api',
      checkedAt: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      checks: { database },
    };
  }
}
