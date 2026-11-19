import { Injectable } from '@nestjs/common';
import { AiService } from '../../core/ai/ai.service';
import type { RequestContext } from '../../core/http/request-context';
import type { AskAssistantBody, AssistantAnswer } from './assistant.schemas';
import { ASSISTANT_TOOLS, AssistantTools } from './assistant.tools';

@Injectable()
export class AssistantService {
  constructor(
    private readonly ai: AiService,
    private readonly tools: AssistantTools,
  ) {}

  async ask(body: AskAssistantBody, ctx: RequestContext): Promise<AssistantAnswer> {
    const result = await this.ai.assist({
      userId: ctx.user.id,
      question: body.question,
      tools: ASSISTANT_TOOLS,
      execute: (name, argumentsJson) => this.tools.execute(name, argumentsJson, ctx.user),
      template: {
        claims: [
          {
            type: 'unknown',
            text: 'The read-only assistant is offline or could not verify an answer. Use the Control Tower and linked detail pages for the verified values.',
          },
        ],
      },
    });
    return {
      source: result.source,
      provider: result.provider,
      toolsUsed: result.toolsUsed,
      claims: result.answer.claims,
    };
  }
}
