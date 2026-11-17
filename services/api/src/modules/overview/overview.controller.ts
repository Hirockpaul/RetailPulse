import { Controller, Get } from '@nestjs/common';
import { READ_ROLES, Roles } from '../../core/auth/roles';
import { Ctx, type RequestContext } from '../../core/http/request-context';
import { OverviewService } from './overview.service';

@Controller('overview')
export class OverviewController {
  constructor(private readonly overview: OverviewService) {}

  /** Store managers get their own stores; everyone else the whole network. */
  @Roles(...READ_ROLES)
  @Get()
  get(@Ctx() ctx: RequestContext) {
    return this.overview.get(ctx.user);
  }
}
