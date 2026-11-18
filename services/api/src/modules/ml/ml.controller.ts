import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { APPROVER_ROLES, READ_ROLES, Roles } from '../../core/auth/roles';
import { Ctx, type RequestContext } from '../../core/http/request-context';
import { ZodValidationPipe } from '../../core/http/zod-validation.pipe';
import { MlService } from './ml.service';
import { type ModelDecision, modelDecisionSchema } from './ml.schemas';

@Controller('ml/models')
export class MlController {
  constructor(private readonly ml: MlService) {}

  @Roles(...READ_ROLES)
  @Get()
  list() {
    return this.ml.overview();
  }

  @Roles(...APPROVER_ROLES)
  @Post(':id/activate')
  activate(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(modelDecisionSchema)) body: ModelDecision,
    @Ctx() ctx: RequestContext,
  ) {
    return this.ml.activate(id, body, ctx);
  }

  @Roles(...APPROVER_ROLES)
  @Post(':id/rollback')
  rollback(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(modelDecisionSchema)) body: ModelDecision,
    @Ctx() ctx: RequestContext,
  ) {
    return this.ml.rollback(id, body, ctx);
  }
}
