import { Injectable, OnModuleInit } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ConsumerRegistry } from '../events/consumer-registry';
import {
  type EventConsumer,
  INVENTORY_MOVEMENT_RECORDED,
  type OutboxEvent,
} from '../events/events.schemas';
import { AlertsService } from './alerts.service';
import { movementPayloadSchema } from './alerts.schemas';

/**
 * Raises, updates and resolves low-stock / out-of-stock alerts after every stock movement.
 * A malformed payload throws, so the event is retried and finally dead-lettered for a human.
 */
@Injectable()
export class LowStockConsumer implements EventConsumer, OnModuleInit {
  readonly name = 'low-stock-alerts';
  readonly eventTypes = [INVENTORY_MOVEMENT_RECORDED];

  constructor(
    private readonly registry: ConsumerRegistry,
    private readonly alerts: AlertsService,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  async handle(event: OutboxEvent, client: PoolClient): Promise<void> {
    const payload = movementPayloadSchema.parse(event.payload);
    await this.alerts.evaluate(client, payload.productId, payload.locationId, event.id);
  }
}
