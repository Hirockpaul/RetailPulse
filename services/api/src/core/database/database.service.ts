import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { ENV, type Env } from '../config/env';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly pool: Pool;
  private readonly logger = new Logger(DatabaseService.name);

  constructor(@Inject(ENV) env: Env) {
    this.pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: 10,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
    });
    // An idle client losing its connection (e.g. Postgres restart) emits 'error'.
    // Unhandled, that would crash the process; the pool discards the client itself.
    this.pool.on('error', (err) => this.logger.warn(`Idle database client error: ${err.message}`));
  }

  query<T extends QueryResultRow>(text: string, params?: unknown[]) {
    return this.pool.query<T>(text, params);
  }

  /** Run `fn` inside a single transaction. Rolls back on any thrown error. */
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Returns round-trip latency in ms, or throws if the database is unreachable. */
  async ping(): Promise<number> {
    const start = performance.now();
    await this.pool.query('SELECT 1');
    return Math.round(performance.now() - start);
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
