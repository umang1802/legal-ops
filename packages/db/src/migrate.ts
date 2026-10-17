import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

/**
 * Applies pending migrations in filename order, each inside its own transaction.
 * A global advisory lock prevents two processes (e.g. API + worker boot) migrating concurrently.
 */
export async function migrate(client: pg.Client, log: (msg: string) => void = () => {}): Promise<string[]> {
  await client.query('SELECT pg_advisory_lock(727274)');
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const ran: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
      log(`applied ${file}`);
      ran.push(file);
    }
    return ran;
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)');
  }
}

/** Drops everything in the public schema. Refuses to run when NODE_ENV=production. */
export async function resetSchema(client: pg.Client): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to reset a production database');
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}
