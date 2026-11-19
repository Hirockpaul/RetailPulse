import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z.string().url().startsWith('postgres'),
    /** Run the event worker inside this process. Default: on, except when NODE_ENV=test. */
    EVENT_WORKER_ENABLED: z.enum(['true', 'false']).optional(),
    /** Hourly cleanup of old outbox events and idempotency keys. Default: on, except in tests. */
    HOUSEKEEPING_ENABLED: z.enum(['true', 'false']).optional(),
    /** Where the internal forecasting service listens (it has no login: keep it private). */
    FORECAST_URL: z.string().url().default('http://127.0.0.1:8000'),
    /** How often the event worker looks for new events. */
    EVENT_POLL_MS: z.coerce.number().int().min(50).max(60_000).default(1000),
    /** Optional explanation provider. `none` is offline and is always the default. */
    AI_PROVIDER: z.enum(['none', 'groq', 'nvidia']).default('none'),
    GROQ_API_KEY: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(1).optional(),
    ),
    GROQ_MODEL: z.string().min(1).default('openai/gpt-oss-20b'),
    NVIDIA_API_KEY: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(1).optional(),
    ),
    NVIDIA_MODEL: z
      .preprocess((value) => (value === '' ? undefined : value), z.string().min(1).optional())
      .default('nvidia/nemotron-3-ultra-550b-a55b'),
    AI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
    AI_MAX_TOKENS: z.coerce.number().int().min(64).max(4096).default(500),
    AI_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(15_000),
  })
  .superRefine((env, ctx) => {
    if (env.AI_PROVIDER === 'groq' && !env.GROQ_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['GROQ_API_KEY'],
        message: 'is required when AI_PROVIDER=groq',
      });
    }
    if (env.AI_PROVIDER === 'nvidia' && !env.NVIDIA_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['NVIDIA_API_KEY'],
        message: 'is required when AI_PROVIDER=nvidia',
      });
    }
  })
  .transform((env) => ({
    ...env,
    EVENT_WORKER_ENABLED:
      env.EVENT_WORKER_ENABLED === undefined
        ? env.NODE_ENV !== 'test'
        : env.EVENT_WORKER_ENABLED === 'true',
    HOUSEKEEPING_ENABLED:
      env.HOUSEKEEPING_ENABLED === undefined
        ? env.NODE_ENV !== 'test'
        : env.HOUSEKEEPING_ENABLED === 'true',
  }));

export type Env = z.infer<typeof EnvSchema>;

/**
 * Load the repo-root .env (if present) without overriding variables already set.
 * Parses and assigns explicitly (rather than process.loadEnvFile) so it also works inside
 * Jest, whose sandbox has its own copy of process.env.
 */
function loadDotEnv(): void {
  for (const candidate of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')]) {
    if (existsSync(candidate)) {
      for (const [key, value] of Object.entries(parseEnv(readFileSync(candidate, 'utf8')))) {
        if (process.env[key] === undefined) process.env[key] = value;
      }
      return;
    }
  }
}

/**
 * Validate environment at startup; fail fast with a readable message (values are never printed).
 * Without an argument, reads process.env after loading the repo-root .env file.
 */
export function loadEnv(source?: NodeJS.ProcessEnv): Env {
  if (!source) loadDotEnv();
  const parsed = EnvSchema.safeParse(source ?? process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${issues.join('\n')}`);
  }
  return parsed.data;
}

export const ENV = Symbol('ENV');
