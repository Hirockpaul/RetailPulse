import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { READ_ROLES, Roles } from '../../core/auth/roles';
import { Ctx, type RequestContext } from '../../core/http/request-context';
import { ZodValidationPipe } from '../../core/http/zod-validation.pipe';
import { type AskAssistantBody, askAssistantBodySchema } from './assistant.schemas';
import { AssistantService } from './assistant.service';

@Controller('assistant')
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Roles(...READ_ROLES)
  @Post('ask')
  @HttpCode(200)
  ask(
    @Body(new ZodValidationPipe(askAssistantBodySchema)) body: AskAssistantBody,
    @Ctx() ctx: RequestContext,
  ) {
    return this.assistant.ask(body, ctx);
  }
}
