import { Module } from '@nestjs/common';
import { IdempotencyModule } from '../../core/idempotency/idempotency.module';
import { EventsModule } from '../events/events.module';
import { HousekeepingService } from './housekeeping.service';

/** Scheduled cleanup of bookkeeping tables. No HTTP routes. */
@Module({
  imports: [EventsModule, IdempotencyModule],
  providers: [HousekeepingService],
})
export class HousekeepingModule {}
