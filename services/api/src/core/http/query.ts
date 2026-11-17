import { z } from 'zod';

export const MAX_PAGE_SIZE = 100;

/** `?page=1&pageSize=25` — bounded so list responses stay small. */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(25),
});

/** Optional free-text search, trimmed; empty string means "no search". */
export const searchSchema = z
  .string()
  .trim()
  .max(100)
  .optional()
  .transform((v) => (v ? v : undefined));

export const uuidSchema = z.uuid({ message: 'Must be a valid UUID.' });
export const idParamSchema = z.object({ id: uuidSchema });

/**
 * `?sort=field:dir` restricted to an allow-list. Each allowed field maps to a fixed SQL
 * expression, so user input never reaches the SQL text.
 */
export function sortSchema<F extends string>(
  columns: Record<F, string>,
  fallback: `${NoInfer<F>}:${'asc' | 'desc'}`,
) {
  const fields = Object.keys(columns) as F[];
  return z
    .string()
    .default(fallback)
    .transform((value, ctx) => {
      const [field, dir = 'asc'] = value.split(':');
      if (!fields.includes(field as F) || (dir !== 'asc' && dir !== 'desc')) {
        ctx.addIssue({
          code: 'custom',
          message: `Use one of: ${fields.map((f) => `${f}:asc|${f}:desc`).join(', ')}.`,
        });
        return z.NEVER;
      }
      return `${columns[field as F]} ${dir.toUpperCase()}`;
    });
}

export interface Page<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
}

export function offsetOf(p: { page: number; pageSize: number }): number {
  return (p.page - 1) * p.pageSize;
}
