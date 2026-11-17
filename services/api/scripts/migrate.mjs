// Minimal, dependency-free SQL migration runner.
// - Applies migrations/NNNN_name.sql in order, each in its own transaction.
// - Records a SHA-256 checksum; refuses to run if an applied file was edited.
// - Uses an advisory lock so two runners can't migrate at the same time.
// Usage: npm run db:migrate            (apply pending)
//        npm run db:migrate -- status  (list applied/pending)
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'migrations');
const rootEnv = resolve(here, '../../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set (copy .env.example to .env).');
  process.exit(1);
}

const LOCK_ID = 727_001; // arbitrary constant for pg_advisory_lock
const files = readdirSync(migrationsDir)
  .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
  .sort();

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )`);

  const { rows } = await client.query('SELECT name, checksum FROM schema_migrations');
  const applied = new Map(rows.map((r) => [r.name, r.checksum]));

  for (const name of applied.keys()) {
    if (!files.includes(name)) throw new Error(`Applied migration ${name} is missing from disk.`);
  }

  const statusOnly = process.argv[2] === 'status';
  let ran = 0;
  for (const name of files) {
    const sql = readFileSync(join(migrationsDir, name), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');

    if (applied.has(name)) {
      if (applied.get(name) !== checksum) {
        throw new Error(
          `Migration ${name} was edited after being applied. Add a new migration instead.`,
        );
      }
      if (statusOnly) console.log(`  applied  ${name}`);
      continue;
    }
    if (statusOnly) {
      console.log(`  pending  ${name}`);
      continue;
    }

    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
        name,
        checksum,
      ]);
      await client.query('COMMIT');
      console.log(`  ✔ ${name}`);
      ran++;
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${name} failed: ${err.message}`, { cause: err });
    }
  }
  if (!statusOnly) console.log(ran ? `Applied ${ran} migration(s).` : 'Database is up to date.');
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
  await client.end();
}
