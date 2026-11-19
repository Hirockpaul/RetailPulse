import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { AiClient, AiProviderError } from './ai.client';
import { AiRepository } from './ai.repository';
import type { AiErrorType, AiExplanationRequest, AiExplanationResult, AiUsage } from './ai.types';

const NO_USAGE: AiUsage = { inputTokens: null, outputTokens: null };

@Injectable()
export class AiService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly repository: AiRepository,
    private readonly client: AiClient,
  ) {}

  async explain(request: AiExplanationRequest): Promise<AiExplanationResult> {
    if (this.env.AI_PROVIDER === 'none') {
      return { answer: request.template, source: 'template' };
    }

    const provider = this.env.AI_PROVIDER;
    const model =
      provider === 'groq' ? this.env.GROQ_MODEL : (this.env.NVIDIA_MODEL ?? 'not-configured');
    const started = performance.now();
    let reservation;
    try {
      reservation = await this.repository.reserve(request.userId, request.feature, provider, model);
    } catch {
      return { answer: request.template, source: 'template' };
    }
    if (!reservation) return { answer: request.template, source: 'template' };

    try {
      const generated = await this.client.generate(request.feature, request.facts);
      await this.repository.complete(
        reservation.requestId,
        'ok',
        Math.round(performance.now() - started),
        generated.usage,
        null,
      );
      return { answer: generated.answer, source: 'ai' };
    } catch (error) {
      const type: AiErrorType = error instanceof AiProviderError ? error.type : 'audit_error';
      await this.repository
        .complete(
          reservation.requestId,
          'fallback',
          Math.round(performance.now() - started),
          NO_USAGE,
          type,
        )
        .catch(() => undefined);
      return { answer: request.template, source: 'template' };
    }
  }
}
