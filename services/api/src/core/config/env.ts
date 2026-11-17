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
    /** How often the event worker looks for new events. */
    EVENT_POLL_MS: z.coerce.number().int().min(50).max(60_000).default(1000),
  })
  .transform((env) => ({
    ...env,
    EVENT_WORKER_ENABLED:
      env.EVENT_WORKER_ENABLED === undefined
        ? env.NODE_ENV !== 'test'
        : env.EVENT_WORKER_ENABLED === 'true',
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
