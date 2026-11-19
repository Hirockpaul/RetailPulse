import { z } from 'zod';
import { AI_CLAIM_TYPES, type AiAnswer, type AiFact } from './ai.types';

export const AI_ANSWER_JSON_SCHEMA = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: AI_CLAIM_TYPES },
          text: { type: 'string' },
        },
        required: ['type', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['claims'],
  additionalProperties: false,
} as const;

const AnswerSchema = z
  .object({
    claims: z
      .array(
        z
          .object({
            type: z.enum(AI_CLAIM_TYPES),
            text: z.string().trim().min(1).max(600),
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();

const NUMBER = /[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?/g;

function canonicalNumber(token: string): string {
  const withoutFormatting = token.replaceAll(',', '').replace(/%$/, '');
  const numeric = Number(withoutFormatting);
  return Number.isFinite(numeric) ? String(numeric) : withoutFormatting;
}

function numbersIn(value: string | number): string[] {
  return String(value).match(NUMBER)?.map(canonicalNumber) ?? [];
}

export class AiValidationError extends Error {
  /**
   * `detail` names what failed, for the log: the offending number (`invented_number`) or the
   * matched word from the fixed lists below (`unsafe_language`). Never the answer text.
   */
  constructor(
    readonly type: 'invalid_json' | 'invalid_schema' | 'invented_number' | 'unsafe_language',
    readonly detail?: string,
  ) {
    super(type);
    this.name = 'AiValidationError';
  }
}

/** Wording each feature must not use, checked over all claims together. */
const FORBIDDEN_WORDS: Record<string, RegExp[]> = {
  forecast: [/\bcaus(?:e|ed|es|ing|al)\b/i, /\b(?:certain(?:ly)?|guaranteed?|definitely)\b/i],
  report: [/\b(?:certain(?:ly)?|guaranteed?|definitely)\b/i],
  anomaly: [/\b(?:certain(?:ly)?|definitely|guaranteed?|proves?|proven)\b/i],
  recommendation: [/\b(?:approv(?:e|ed|es|ing)|reject(?:ed|s|ing)?)\b/i],
};

/** Parse the model JSON and reject every number not present in the backend-selected facts. */
export function validateAiAnswer(content: string, facts: AiFact[], feature?: string): AiAnswer {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    throw new AiValidationError('invalid_json');
  }
  const parsed = AnswerSchema.safeParse(json);
  if (!parsed.success) throw new AiValidationError('invalid_schema');

  // Labels describe a value but are not themselves evidence. A label such as "95% range" must
  // not authorize the model to use 95 unless the backend also sends 95 as an explicit value.
  const allowed = new Set(facts.flatMap((fact) => numbersIn(fact.value)));
  for (const claim of parsed.data.claims) {
    for (const number of numbersIn(claim.text)) {
      if (!allowed.has(number)) throw new AiValidationError('invented_number', number);
    }
  }
  const text = parsed.data.claims.map((claim) => claim.text).join(' ');
  for (const pattern of FORBIDDEN_WORDS[feature ?? ''] ?? []) {
    const match = pattern.exec(text);
    if (match) throw new AiValidationError('unsafe_language', match[0].toLowerCase());
  }
  return parsed.data;
}
