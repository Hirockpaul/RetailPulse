import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { Page } from '../../core/http/query';
import { EventDispatcher } from './event-dispatcher';
import { EventsRepository } from './events.repository';
import type {
  DeadEvent,
  DeadEventsQuery,
  EventStats,
  NewEvent,
  WorkerState,
} from './events.schemas';

@Injectable()
export class EventsService {
  constructor(
    private readonly repo: EventsRepository,
    private readonly dispatcher: EventDispatcher,
  ) {}

  /**
   * Record an event in the outbox. MUST be called with the same `client` (transaction) as the
   * change that caused it: if that transaction rolls back, the event is never created.
   * Returns the new event id.
   */
  async record(client: PoolClient, event: NewEvent): Promise<string> {
    const id = randomUUID();
    await this.repo.insert(client, id, event);
    return id;
  }

  async stats(): Promise<{ events: EventStats; worker: WorkerState }> {
    return { events: await this.repo.stats(), worker: this.dispatcher.state() };
  }

  async listDead(query: DeadEventsQuery): Promise<Page<DeadEvent>> {
    const { rows, total } = await this.repo.listDead(query);
    return { data: rows, page: query.page, pageSize: query.pageSize, total };
  }

  /** Re-deliver an event. Consumers that already handled it skip it (idempotent). */
  async replay(id: string): Promise<{ id: string; status: 'PENDING' }> {
    const result = await this.repo.requeue(id);
    if (result === 'not-found') {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Event not found.' });
    }
    if (result === 'already-pending') {
      throw new ConflictException({
        code: 'EVENT_ALREADY_PENDING',
        message: 'This event is already waiting to be processed.',
      });
    }
    return { id, status: 'PENDING' };
  }
}
