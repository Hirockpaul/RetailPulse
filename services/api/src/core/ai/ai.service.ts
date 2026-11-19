import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { AiClient, AiProviderError } from './ai.client';
import { AiRepository } from './ai.repository';
import type {
  AiErrorType,
  AiExplanationRequest,
  AiExplanationResult,
  AiProvider,
  AiUsage,
} from './ai.types';

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

    for (const provider of this.providers()) {
      const model = provider === 'groq' ? this.env.GROQ_MODEL : this.env.NVIDIA_MODEL;
      const started = performance.now();
      let reservation;
      try {
        reservation = await this.repository.reserve(
          request.userId,
          request.feature,
          provider,
          model,
        );
      } catch {
        return { answer: request.template, source: 'template' };
      }
      // A null reservation means the shared per-user limit is exhausted. Trying another provider
      // would bypass that limit, so return the local template immediately.
      if (!reservation) return { answer: request.template, source: 'template' };

      try {
        const generated = await this.client.generate(provider, request.feature, request.facts);
        await this.repository.complete(
          reservation.requestId,
          'ok',
          Math.round(performance.now() - started),
          generated.usage,
          null,
        );
        return { answer: generated.answer, source: 'ai', provider };
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
      }
    }
    return { answer: request.template, source: 'template' };
  }

  private providers(): AiProvider[] {
    const preferred = this.env.AI_PROVIDER as AiProvider;
    const fallback: AiProvider = preferred === 'groq' ? 'nvidia' : 'groq';
    const fallbackConfigured =
      fallback === 'groq' ? Boolean(this.env.GROQ_API_KEY) : Boolean(this.env.NVIDIA_API_KEY);
    return fallbackConfigured ? [preferred, fallback] : [preferred];
  }
}
