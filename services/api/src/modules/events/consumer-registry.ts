import { Injectable } from '@nestjs/common';
import type { EventConsumer } from './events.schemas';

/**
 * Consumers register themselves (usually in onModuleInit), so the events module does not need
 * to know which modules consume events — no dependency from events to its consumers.
 */
@Injectable()
export class ConsumerRegistry {
  private readonly consumers = new Map<string, EventConsumer>();

  register(consumer: EventConsumer): void {
    if (this.consumers.has(consumer.name)) {
      throw new Error(`Event consumer "${consumer.name}" is already registered.`);
    }
    this.consumers.set(consumer.name, consumer);
  }

  unregister(name: string): void {
    this.consumers.delete(name);
  }

  forType(eventType: string): EventConsumer[] {
    return [...this.consumers.values()].filter((c) => c.eventTypes.includes(eventType));
  }
}
