import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { APPROVER_ROLES, Roles } from '../../core/auth/roles';
import { idParamSchema } from '../../core/http/query';
import { ZodValidationPipe } from '../../core/http/zod-validation.pipe';
import { type DeadEventsQuery, deadEventsQuerySchema } from './events.schemas';
import { EventsService } from './events.service';

/** Event monitoring for operators (admins and inventory managers). */
@Roles(...APPROVER_ROLES)
@Controller('ops/events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  /** Backlog, retries, dead letters and worker state. */
  @Get()
  stats() {
    return this.events.stats();
  }

  @Get('dead')
  dead(@Query(new ZodValidationPipe(deadEventsQuerySchema)) query: DeadEventsQuery) {
    return this.events.listDead(query);
  }

  /** Re-deliver an event; consumers that already handled it will skip it. */
  @Post(':id/replay')
  replay(@Param(new ZodValidationPipe(idParamSchema)) { id }: { id: string }) {
    return this.events.replay(id);
  }
}
