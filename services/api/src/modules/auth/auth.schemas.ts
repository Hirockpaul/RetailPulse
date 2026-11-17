import { z } from 'zod';
import { MAX_PASSWORD_LENGTH } from '../../core/auth/password';

export const loginBodySchema = z.object({
  email: z.string().trim().max(254).pipe(z.email()),
  // No minimum length here: login must accept whatever the account has; length is a creation rule.
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});
export type LoginBody = z.output<typeof loginBodySchema>;
