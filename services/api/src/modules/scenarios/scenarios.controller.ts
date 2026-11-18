import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { APPROVER_ROLES, Roles } from '../../core/auth/roles';
import { idParamSchema } from '../../core/http/query';
import { Ctx, type RequestContext } from '../../core/http/request-context';
import { ZodValidationPipe } from '../../core/http/zod-validation.pipe';
import { type CreateScenario, createScenarioSchema } from './scenarios.schemas';
import { ScenariosService } from './scenarios.service';

/**
 * Results are network-wide, so only roles that see every location may read them (store managers
 * would see other stores' needs). Creating and running: admins and inventory managers.
 */
@Controller('scenarios')
export class ScenariosController {
  constructor(private readonly scenarios: ScenariosService) {}

  @Roles(...APPROVER_ROLES)
  @Post()
  create(
    @Body(new ZodValidationPipe(createScenarioSchema)) body: CreateScenario,
    @Ctx() ctx: RequestContext,
  ) {
    return this.scenarios.create(body, ctx);
  }

  @Roles('ADMIN', 'INVENTORY_MANAGER', 'ANALYST')
  @Get()
  list() {
    return this.scenarios.list();
  }

  @Roles('ADMIN', 'INVENTORY_MANAGER', 'ANALYST')
  @Get(':id')
  get(@Param(new ZodValidationPipe(idParamSchema)) { id }: { id: string }) {
    return this.scenarios.get(id);
  }

  @Roles(...APPROVER_ROLES)
  @Post(':id/run')
  @HttpCode(200)
  run(
    @Param(new ZodValidationPipe(idParamSchema)) { id }: { id: string },
    @Ctx() ctx: RequestContext,
  ) {
    return this.scenarios.run(id, ctx);
  }
}
