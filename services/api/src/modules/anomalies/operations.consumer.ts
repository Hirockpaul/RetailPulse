import { Injectable, OnModuleInit } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { uuidSchema } from '../../core/http/query';
import { ConsumerRegistry } from '../events/consumer-registry';
import {
  type EventConsumer,
  INVENTORY_MOVEMENT_RECORDED,
  type OutboxEvent,
} from '../events/events.schemas';
import { AnomaliesService } from './anomalies.service';

const payloadSchema = z.object({
  ledgerId: z.string().min(1),
  productId: uuidSchema,
  locationId: uuidSchema,
  movementType: z.string(),
  onHandDelta: z.number().int(),
  onHandAfter: z.number().int(),
});

/**
 * Applies the operational-anomaly rules after adjustments and returns. A malformed payload
 * throws, so the event is retried and finally dead-lettered for a human (like the alerts).
 */
@Injectable()
export class OperationsAnomalyConsumer implements EventConsumer, OnModuleInit {
  readonly name = 'operational-anomalies';
  readonly eventTypes = [INVENTORY_MOVEMENT_RECORDED];

  constructor(
    private readonly registry: ConsumerRegistry,
    private readonly anomalies: AnomaliesService,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  async handle(event: OutboxEvent, client: PoolClient): Promise<void> {
    await this.anomalies.evaluateMovement(client, payloadSchema.parse(event.payload), event.id);
  }
}
