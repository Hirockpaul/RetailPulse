import type { PoolClient } from 'pg';
import type { DatabaseService } from '../database/database.service';
import { AiRepository } from './ai.repository';

describe('AiRepository', () => {
  it('serializes each user and writes only metadata in ai_requests', async () => {
    const statements: string[] = [];
    const client = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes('count(*)')) return { rows: [{ count: 0 }] };
        if (sql.includes('RETURNING id')) return { rows: [{ id: 17 }] };
        return { rows: [] };
      }),
    } as unknown as PoolClient;
    const db = {
      transaction: async <T>(fn: (transactionClient: PoolClient) => Promise<T>) => fn(client),
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
        return { rows: [] };
      }),
    } as unknown as DatabaseService;
    const repository = new AiRepository(db);

    await expect(
      repository.reserve(
        '00000000-0000-0000-0000-000000000001',
        'forecast',
        'groq',
        'openai/gpt-oss-20b',
      ),
    ).resolves.toEqual({ requestId: 17 });
    await repository.complete(17, 'ok', 25, { inputTokens: 10, outputTokens: 4 }, null);

    expect(statements.some((sql) => sql.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(statements.filter((sql) => /\b(?:INSERT|UPDATE|DELETE)\b/i.test(sql))).toEqual([
      expect.stringMatching(/INSERT INTO ai_requests/),
      expect.stringMatching(/UPDATE ai_requests/),
    ]);
    expect(statements.join('\n')).not.toMatch(
      /(?:inventory_balances|inventory_ledger|replenishment_recommendations|purchase_orders|stock_transfers)/,
    );
  });

  it('rejects the twenty-first request and records the rate-limit fallback', async () => {
    const client = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('count(*)')) return { rows: [{ count: 20 }] };
        return { rows: [] };
      }),
    } as unknown as PoolClient;
    const db = {
      transaction: async <T>(fn: (transactionClient: PoolClient) => Promise<T>) => fn(client),
    } as unknown as DatabaseService;
    const repository = new AiRepository(db);

    await expect(
      repository.reserve(
        '00000000-0000-0000-0000-000000000001',
        'forecast',
        'groq',
        'openai/gpt-oss-20b',
      ),
    ).resolves.toBeNull();
    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT INTO ai_requests/),
      expect.arrayContaining(['fallback', 'rate_limit']),
    );
  });
});
