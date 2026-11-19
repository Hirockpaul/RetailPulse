import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ENV, type Env } from '../config/env';
import type { AiErrorType, AiFact, AiFeature, AiGeneratedAnswer } from './ai.types';
import { AI_ANSWER_JSON_SCHEMA, AiValidationError, validateAiAnswer } from './ai.validation';

export const AI_FETCH = Symbol('AI_FETCH');
export const AI_SLEEP = Symbol('AI_SLEEP');
export type AiFetch = (url: string, init: RequestInit) => Promise<Response>;
export type AiSleep = (milliseconds: number) => Promise<void>;

const EnvelopeSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export class AiProviderError extends Error {
  constructor(readonly type: AiErrorType) {
    super(type);
    this.name = 'AiProviderError';
  }
}

function retryAfterSeconds(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.max(0, (date - Date.now()) / 1000);
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

@Injectable()
export class AiClient {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(AI_FETCH) private readonly fetcher: AiFetch,
    @Inject(AI_SLEEP) private readonly sleep: AiSleep,
  ) {}

  async generate(feature: AiFeature, facts: AiFact[]): Promise<AiGeneratedAnswer> {
    if (this.env.AI_PROVIDER !== 'groq') {
      throw new AiProviderError('unsupported_provider');
    }

    const body = JSON.stringify({
      model: this.env.GROQ_MODEL,
      temperature: this.env.AI_TEMPERATURE,
      max_tokens: this.env.AI_MAX_TOKENS,
      messages: [
        {
          role: 'system',
          content:
            'Explain only the supplied verified facts in plain language. Do not add numbers. ' +
            'Tag every claim. Predictions are uncertain. Model factors are associations, never causes. ' +
            'Anomaly flags are signals to investigate, never proof of wrongdoing or a known cause. ' +
            'For recommendations, explain the existing suggestion but never approve, reject, or create an order.',
        },
        { role: 'user', content: JSON.stringify({ feature, facts }) },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'retailpulse_explanation',
          strict: true,
          schema: AI_ANSWER_JSON_SCHEMA,
        },
      },
    });

    let validationFailures = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response;
      try {
        response = await this.fetcher('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.env.GROQ_API_KEY}`,
            'content-type': 'application/json',
          },
          body,
          signal: AbortSignal.timeout(this.env.AI_TIMEOUT_MS),
        });
      } catch (error) {
        const type: AiErrorType = isTimeout(error) ? 'timeout' : 'network';
        if (attempt < 2) {
          await this.sleep(attempt === 0 ? 1000 : 2000);
          continue;
        }
        throw new AiProviderError(type);
      }

      if (response.status === 429) {
        const wait = retryAfterSeconds(response.headers.get('retry-after'));
        if (wait !== null && wait <= 10 && attempt < 2) {
          await this.sleep(wait * 1000);
          continue;
        }
        throw new AiProviderError('rate_limit');
      }
      if (response.status >= 500) {
        if (attempt < 2) {
          await this.sleep(attempt === 0 ? 1000 : 2000);
          continue;
        }
        throw new AiProviderError('provider_5xx');
      }
      if (!response.ok) throw new AiProviderError('provider_4xx');

      try {
        const envelope = EnvelopeSchema.parse(await response.json());
        return {
          answer: validateAiAnswer(envelope.choices[0].message.content, facts, feature),
          usage: {
            inputTokens: envelope.usage?.prompt_tokens ?? null,
            outputTokens: envelope.usage?.completion_tokens ?? null,
          },
        };
      } catch (error) {
        const type =
          error instanceof AiValidationError
            ? error.type
            : error instanceof SyntaxError
              ? 'invalid_json'
              : 'invalid_schema';
        validationFailures++;
        if (validationFailures <= 1 && attempt < 2) {
          await this.sleep(1000);
          continue;
        }
        throw new AiProviderError(type);
      }
    }
    throw new AiProviderError('network');
  }
}
