import { Module } from '@nestjs/common';
import { ConsumerRegistry } from './consumer-registry';
import { EventDispatcher } from './event-dispatcher';
import { EventsController } from './events.controller';
import { EventsRepository } from './events.repository';
import { EventsService } from './events.service';

/**
 * Transactional outbox + in-process worker (no message broker).
 * Producers call EventsService.record(client, …) inside their transaction; consumers register
 * with the ConsumerRegistry. This module depends on nothing but the database.
 */
@Module({
  controllers: [EventsController],
  providers: [EventsService, EventsRepository, ConsumerRegistry, EventDispatcher],
  exports: [EventsService, ConsumerRegistry, EventDispatcher],
})
export class EventsModule {}
