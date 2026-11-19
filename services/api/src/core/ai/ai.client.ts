import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { ENV, type Env } from '../config/env';
import type {
  AiErrorType,
  AiFact,
  AiFeature,
  AiGeneratedAnswer,
  AiGeneratedAssistant,
  AiProvider,
  AiToolDefinition,
  AiToolExecutor,
} from './ai.types';
import { AI_ANSWER_JSON_SCHEMA, AiValidationError, validateAiAnswer } from './ai.validation';

export const AI_FETCH = Symbol('AI_FETCH');
export const AI_SLEEP = Symbol('AI_SLEEP');
export type AiFetch = (url: string, init: RequestInit) => Promise<Response>;
export type AiSleep = (milliseconds: number) => Promise<void>;

const EnvelopeSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string() }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

const ToolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal('function'),
  function: z.object({ name: z.string().min(1), arguments: z.string() }),
});

const AssistantEnvelopeSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          role: z.string().optional(),
          content: z.string().nullable().optional(),
          tool_calls: z.array(ToolCallSchema).optional(),
        }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

type AssistantMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls: z.infer<typeof ToolCallSchema>[] }
  | { role: 'tool'; tool_call_id: string; name: string; content: string };

export class AiProviderError extends Error {
  /** `detail` is only ever a short provider error code (e.g. `json_validate_failed`), never text. */
  constructor(
    readonly type: AiErrorType,
    readonly detail?: string,
  ) {
    super(type);
    this.name = 'AiProviderError';
  }
}

const SAFE_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * The provider's own error code from an error response, for the log. Only a short code-shaped
 * string is kept: provider messages can echo request content, so they are never read out.
 */
async function providerErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown; type?: unknown } };
    const code = body?.error?.code ?? body?.error?.type;
    return typeof code === 'string' && SAFE_CODE.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Provider- and model-specific request fields, as documented by each provider.
 * - Groq: `max_tokens` is deprecated in favour of `max_completion_tokens`. Its gpt-oss models reason
 *   before answering and that reasoning counts against the same budget; a cut-off answer is invalid
 *   JSON. So gpt-oss is asked for little reasoning and none of it in the reply.
 * - NVIDIA: `max_tokens`, no streaming, reasoning off.
 */
function providerFields(provider: AiProvider, model: string, maxTokens: number) {
  if (provider === 'nvidia') {
    return { max_tokens: maxTokens, stream: false, reasoning_effort: 'none' };
  }
  const fields: Record<string, unknown> = { max_completion_tokens: maxTokens };
  if (model.startsWith('openai/gpt-oss')) {
    fields.reasoning_effort = 'low';
    fields.include_reasoning = false;
  }
  return fields;
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
  private readonly logger = new Logger(AiClient.name);

  /** One line per rejected answer: which check failed and its short reason, never the answer. */
  private logRejected(provider: AiProvider, feature: string, error: unknown, retrying: boolean) {
    const type =
      error instanceof AiValidationError
        ? error.type
        : error instanceof SyntaxError
          ? 'invalid_json'
          : 'invalid_schema';
    const detail = error instanceof AiValidationError && error.detail ? ` (${error.detail})` : '';
    this.logger.warn(
      `AI provider ${provider} ${feature} answer rejected: ${type}${detail}${retrying ? '; retrying once' : ''}`,
    );
  }

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(AI_FETCH) private readonly fetcher: AiFetch,
    @Inject(AI_SLEEP) private readonly sleep: AiSleep,
  ) {}

  async generate(
    provider: AiProvider,
    feature: AiFeature,
    facts: AiFact[],
  ): Promise<AiGeneratedAnswer> {
    const config = this.providerConfig(provider);

    const request: Record<string, unknown> = {
      model: config.model,
      temperature: this.env.AI_TEMPERATURE,
      ...providerFields(provider, config.model, this.env.AI_MAX_TOKENS),
      messages: [
        {
          role: 'system',
          content:
            'Explain only the supplied verified facts in plain language. Do not add numbers. ' +
            'Return exactly one JSON object shaped as ' +
            '{"claims":[{"type":"fact|prediction|estimate|recommendation|unknown","text":"plain-language claim"}]}. ' +
            'Use only those five type values, include no other keys, and return no markdown. ' +
            'Predictions are uncertain. Model factors are associations, never causes. ' +
            'Anomaly flags are signals to investigate, never proof of wrongdoing or a known cause. ' +
            'For recommendations, explain the existing suggestion but never approve, reject, or create an order.',
        },
        { role: 'user', content: JSON.stringify({ feature, facts }) },
      ],
    };
    if (provider === 'groq') {
      request.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'retailpulse_explanation',
          strict: true,
          schema: AI_ANSWER_JSON_SCHEMA,
        },
      };
    } else {
      // NVIDIA hosted NIM streams and reasons visibly by default; providerFields() turns both off.
      request.response_format = { type: 'json_object' };
    }
    const body = JSON.stringify(request);

    let validationFailures = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response;
      try {
        response = await this.fetcher(config.url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.key}`,
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
        throw new AiProviderError('rate_limit', await providerErrorCode(response));
      }
      if (response.status >= 500) {
        if (attempt < 2) {
          await this.sleep(attempt === 0 ? 1000 : 2000);
          continue;
        }
        throw new AiProviderError('provider_5xx', await providerErrorCode(response));
      }
      if (!response.ok) {
        throw new AiProviderError('provider_4xx', await providerErrorCode(response));
      }

      try {
        const envelope = EnvelopeSchema.parse(await response.json());
        // Out of tokens: the JSON is incomplete, and asking again with the same budget cannot help.
        if (envelope.choices[0].finish_reason === 'length') {
          throw new AiProviderError('truncated');
        }
        return {
          answer: validateAiAnswer(envelope.choices[0].message.content, facts, feature),
          usage: {
            inputTokens: envelope.usage?.prompt_tokens ?? null,
            outputTokens: envelope.usage?.completion_tokens ?? null,
          },
        };
      } catch (error) {
        if (error instanceof AiProviderError) throw error;
        const type =
          error instanceof AiValidationError
            ? error.type
            : error instanceof SyntaxError
              ? 'invalid_json'
              : 'invalid_schema';
        validationFailures++;
        const retrying = validationFailures <= 1 && attempt < 2;
        this.logRejected(provider, feature, error, retrying);
        if (retrying) {
          await this.sleep(1000);
          continue;
        }
        throw new AiProviderError(
          type,
          error instanceof AiValidationError ? error.detail : undefined,
        );
      }
    }
    throw new AiProviderError('network');
  }

  /** Run a bounded local-tool loop. Provider-requested names and arguments are untrusted input. */
  async assist(
    provider: AiProvider,
    question: string,
    tools: AiToolDefinition[],
    execute: AiToolExecutor,
  ): Promise<AiGeneratedAssistant> {
    const config = this.providerConfig(provider);
    const messages: AssistantMessage[] = [
      {
        role: 'system',
        content:
          "You are RetailPulse's read-only manager assistant for synthetic demo data. " +
          "Use at least one supplied tool before answering. Tools already enforce the caller's permissions. " +
          'Never claim to change stock, approve or reject work, create orders, or review findings. ' +
          'Do not infer missing values. Predictions are uncertain and model factors are associations, not causes. ' +
          'Your final response must be only one JSON object shaped as ' +
          '{"claims":[{"type":"fact|prediction|estimate|recommendation|unknown","text":"plain-language claim"}]}. ' +
          'Use only numbers present in tool results, include no other keys, and return no markdown.',
      },
      { role: 'user', content: question },
    ];
    const knownTools = new Set(tools.map((tool) => tool.function.name));
    const facts: AiFact[] = [];
    const toolsUsed: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let usageKnown = true;
    let validationFailures = 0;

    for (let round = 0; round < 4; round++) {
      const envelope = await this.assistantCompletion(provider, config, messages, tools);
      if (envelope.usage?.prompt_tokens === undefined) usageKnown = false;
      else inputTokens += envelope.usage.prompt_tokens;
      if (envelope.usage?.completion_tokens === undefined) usageKnown = false;
      else outputTokens += envelope.usage.completion_tokens;
      if (envelope.choices[0].finish_reason === 'length') throw new AiProviderError('truncated');

      const message = envelope.choices[0].message;
      const calls = message.tool_calls ?? [];
      if (calls.length > 0) {
        if (calls.length > 3 || toolsUsed.length + calls.length > 6) {
          throw new AiProviderError('invalid_schema');
        }
        messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: calls });
        for (const call of calls) {
          if (!knownTools.has(call.function.name)) throw new AiProviderError('invalid_schema');
          let result;
          try {
            result = await execute(call.function.name, call.function.arguments);
          } catch {
            throw new AiProviderError('invalid_schema');
          }
          facts.push(...result.facts);
          toolsUsed.push(call.function.name);
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.function.name,
            content: JSON.stringify(result.content),
          });
        }
        continue;
      }

      if (facts.length === 0 || !message.content) throw new AiProviderError('invalid_schema');
      let answer;
      try {
        answer = validateAiAnswer(message.content, facts, 'assistant');
      } catch (error) {
        const type = error instanceof AiValidationError ? error.type : 'invalid_schema';
        validationFailures++;
        const retrying = validationFailures <= 1 && round < 3;
        this.logRejected(provider, 'assistant', error, retrying);
        if (retrying) {
          messages.push({ role: 'assistant', content: message.content });
          messages.push({
            role: 'user',
            content:
              'That response failed the required JSON, claim-tag, or numeric-evidence check. ' +
              'Retry once using only the tool results already supplied and no new numbers.',
          });
          continue;
        }
        throw new AiProviderError(
          type,
          error instanceof AiValidationError ? error.detail : undefined,
        );
      }
      return {
        answer,
        toolsUsed: [...new Set(toolsUsed)],
        usage: {
          inputTokens: usageKnown ? inputTokens : null,
          outputTokens: usageKnown ? outputTokens : null,
        },
      };
    }
    throw new AiProviderError('invalid_schema');
  }

  private providerConfig(provider: AiProvider) {
    const config =
      provider === 'groq'
        ? {
            url: 'https://api.groq.com/openai/v1/chat/completions',
            key: this.env.GROQ_API_KEY,
            model: this.env.GROQ_MODEL,
          }
        : {
            url: 'https://integrate.api.nvidia.com/v1/chat/completions',
            key: this.env.NVIDIA_API_KEY,
            model: this.env.NVIDIA_MODEL,
          };
    if (!config.key) throw new AiProviderError('unsupported_provider');
    return config;
  }

  private async assistantCompletion(
    provider: AiProvider,
    config: ReturnType<AiClient['providerConfig']>,
    messages: AssistantMessage[],
    tools: AiToolDefinition[],
  ): Promise<z.infer<typeof AssistantEnvelopeSchema>> {
    const body: Record<string, unknown> = {
      model: config.model,
      temperature: this.env.AI_TEMPERATURE,
      ...providerFields(provider, config.model, this.env.AI_MAX_TOKENS),
      messages,
      tools,
      tool_choice: 'auto',
      parallel_tool_calls: false,
    };

    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response;
      try {
        response = await this.fetcher(config.url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.key}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
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
        throw new AiProviderError('rate_limit', await providerErrorCode(response));
      }
      if (response.status >= 500) {
        if (attempt < 2) {
          await this.sleep(attempt === 0 ? 1000 : 2000);
          continue;
        }
        throw new AiProviderError('provider_5xx', await providerErrorCode(response));
      }
      if (!response.ok) {
        throw new AiProviderError('provider_4xx', await providerErrorCode(response));
      }
      try {
        return AssistantEnvelopeSchema.parse(await response.json());
      } catch {
        if (attempt < 1) {
          await this.sleep(1000);
          continue;
        }
        throw new AiProviderError('invalid_schema');
      }
    }
    throw new AiProviderError('network');
  }
}
