import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ENV, type Env } from '../../core/config/env';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { EventsService } from '../events/events.service';
import { HOUSEKEEPING } from './housekeeping.config';

export interface HousekeepingResult {
  outboxEvents: number;
  idempotencyKeys: number;
}

/**
 * Deletes bookkeeping rows that have served their purpose: processed outbox events and old
 * idempotency keys. Runs inside the API on a timer (HOUSEKEEPING_ENABLED, off in tests, which
 * call runOnce() directly). Safe with several instances: deletes are batched and skip locked rows.
 */
@Injectable()
export class HousekeepingService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(HousekeepingService.name);
  private timer: NodeJS.Timeout | undefined;
  private current: Promise<unknown> | undefined;
  private stopped = true;

  constructor(
    private readonly events: EventsService,
    private readonly idempotency: IdempotencyService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onApplicationBootstrap() {
    if (!this.env.HOUSEKEEPING_ENABLED) return;
    this.stopped = false;
    this.schedule(HOUSEKEEPING.firstRunDelayMs);
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.current;
  }

  async runOnce(): Promise<HousekeepingResult> {
    const result = {
      outboxEvents: await this.events.purgeProcessed(HOUSEKEEPING.outboxRetentionDays),
      idempotencyKeys: await this.idempotency.purgeOlderThan(HOUSEKEEPING.idempotencyRetentionDays),
    };
    if (result.outboxEvents + result.idempotencyKeys > 0) {
      this.logger.log(
        `Purged ${result.outboxEvents} processed events and ${result.idempotencyKeys} idempotency keys.`,
      );
    }
    return result;
  }

  private schedule(delayMs: number) {
    this.timer = setTimeout(() => {
      this.current = this.runOnce()
        .catch((err: unknown) =>
          this.logger.warn(`Housekeeping failed: ${err instanceof Error ? err.message : err}`),
        )
        .finally(() => {
          this.current = undefined;
          if (!this.stopped) this.schedule(HOUSEKEEPING.intervalMs);
        });
    }, delayMs);
    this.timer.unref();
  }
}
