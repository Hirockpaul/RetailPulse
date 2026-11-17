/** How long bookkeeping rows are kept. Business records (ledger, orders, alerts) are never purged. */
export const HOUSEKEEPING = {
  /** Processed outbox events (and their handled marks). Dead letters are kept until replayed. */
  outboxRetentionDays: 7,
  /** Idempotency keys: a retry with the same key within this window replays the first answer. */
  idempotencyRetentionDays: 7,
  /** First run shortly after start-up, then once an hour. */
  firstRunDelayMs: 60_000,
  intervalMs: 60 * 60 * 1000,
} as const;
