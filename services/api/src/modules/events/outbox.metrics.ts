import { Injectable, OnModuleInit } from '@nestjs/common';
import { Gauge } from '@prometheus-io/client';
import { MetricsService } from '../../core/metrics/metrics.service';
import { EventsRepository } from './events.repository';
import type { EventStats } from './events.schemas';

/**
 * Outbox backlog for Prometheus, read from the database at scrape time (so it is correct even
 * with several API instances). If the database cannot be read, the per-state series are left
 * out of that scrape rather than repeating stale numbers (the client always prints an
 * unlabelled gauge, so the age then reads 0 — the health check reports the outage).
 */
@Injectable()
export class OutboxMetrics implements OnModuleInit {
  constructor(
    private readonly metrics: MetricsService,
    private readonly repo: EventsRepository,
  ) {}

  onModuleInit() {
    const read = async (): Promise<EventStats | null> => {
      try {
        return await this.repo.stats();
      } catch {
        return null; // database unreachable: health reports the outage
      }
    };

    new Gauge({
      name: 'retailpulse_outbox_events',
      help: 'Outbox events by state: pending (never tried), retrying, dead (dead letters).',
      labelNames: ['state'] as const,
      registers: [this.metrics.registry],
      async collect() {
        this.reset();
        const s = await read();
        if (!s) return;
        this.set({ state: 'pending' }, s.pending);
        this.set({ state: 'retrying' }, s.retrying);
        this.set({ state: 'dead' }, s.dead);
      },
    });
    new Gauge({
      name: 'retailpulse_outbox_oldest_pending_seconds',
      help: 'Age of the oldest event still waiting to be processed (0 when none).',
      registers: [this.metrics.registry],
      async collect() {
        this.reset();
        const s = await read();
        if (s) this.set(s.oldestPendingSeconds ?? 0);
      },
    });
  }
}
