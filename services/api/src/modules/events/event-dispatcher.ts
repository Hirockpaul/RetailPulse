import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ENV, type Env } from '../../core/config/env';
import { DatabaseService } from '../../core/database/database.service';
import { ConsumerRegistry } from './consumer-registry';
import { EventsRepository } from './events.repository';
import {
  MAX_ATTEMPTS,
  type OutboxEvent,
  retryDelaySeconds,
  type WorkerState,
} from './events.schemas';

export interface RunResult {
  processed: number;
  retried: number;
  dead: number;
}

/**
 * The "publisher": claims outbox events one at a time and runs the matching consumers.
 *
 * Per event, ONE transaction holds: the row lock → consumers' writes → processed marks.
 *  - success: everything commits together (effect applied exactly once);
 *  - a consumer throws: its writes roll back to a savepoint, the failure is recorded
 *    (attempts, error, backoff) and the event is retried — or parked as DEAD after
 *    MAX_ATTEMPTS (the dead-letter queue is the DEAD rows; /ops/events/dead lists them).
 * Safe with several workers (SKIP LOCKED). Events are processed in order, except that a
 * failing event is retried later while newer ones continue — so consumers must not rely on order.
 */
@Injectable()
export class EventDispatcher implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(EventDispatcher.name);
  private timer: NodeJS.Timeout | undefined;
  private current: Promise<void> | undefined;
  private stopped = true;
  private lastRunAt: Date | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly repo: EventsRepository,
    private readonly registry: ConsumerRegistry,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onApplicationBootstrap() {
    if (this.env.EVENT_WORKER_ENABLED) this.start();
  }

  async onModuleDestroy() {
    await this.stop();
  }

  state(): WorkerState {
    return {
      enabled: !this.stopped,
      pollMs: this.env.EVENT_POLL_MS,
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  /** Stop polling and wait for the batch in progress to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.current;
  }

  private schedule(delayMs: number) {
    this.timer = setTimeout(() => {
      this.current = this.tick().finally(() => {
        this.current = undefined;
        if (!this.stopped) this.schedule(this.env.EVENT_POLL_MS);
      });
    }, delayMs);
    this.timer.unref();
  }

  private async tick() {
    try {
      await this.runOnce();
      this.lastError = null;
    } catch (err) {
      // Typically the database being unreachable; keep polling, the outbox just queues.
      this.lastError = describe(err);
      this.logger.warn(`Event worker run failed: ${this.lastError}`);
    }
  }

  /** Process due events until none are left (or `limit` is reached). Also used by tests. */
  async runOnce(limit = 200): Promise<RunResult> {
    const result: RunResult = { processed: 0, retried: 0, dead: 0 };
    for (let i = 0; i < limit; i++) {
      const outcome = await this.processNext();
      if (outcome === 'none') break;
      if (outcome === 'processed') result.processed++;
      else if (outcome === 'retry') result.retried++;
      else result.dead++;
    }
    this.lastRunAt = new Date();
    return result;
  }

  private processNext(): Promise<'none' | 'processed' | 'retry' | 'dead'> {
    return this.db.transaction(async (client) => {
      const event = await this.repo.claimNext(client);
      if (!event) return 'none';

      await client.query('SAVEPOINT handlers');
      try {
        await this.runConsumers(client, event);
        await this.repo.markProcessed(client, event.id);
        await client.query('RELEASE SAVEPOINT handlers');
        return 'processed';
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT handlers'); // undo the consumers' partial writes
        const attempt = event.attempts + 1;
        const dead = attempt >= MAX_ATTEMPTS;
        const message = describe(err);
        await this.repo.markFailed(client, event.id, message, dead, retryDelaySeconds(attempt));
        this.logger.warn(
          `Event ${event.id} (${event.eventType}) failed attempt ${attempt}/${MAX_ATTEMPTS}` +
            `${dead ? ' — moved to dead letters' : ''}: ${message}`,
        );
        return dead ? 'dead' : 'retry';
      }
    });
  }

  private async runConsumers(
    client: Parameters<EventsRepository['recordHandled']>[0],
    event: OutboxEvent,
  ) {
    for (const consumer of this.registry.forType(event.eventType)) {
      // Already handled by this consumer (e.g. a replay)? Skip — that is the idempotency guarantee.
      if (!(await this.repo.recordHandled(client, consumer.name, event.id))) continue;
      await consumer.handle(event, client);
    }
  }
}

function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 500);
}
