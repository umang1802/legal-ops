import pg from 'pg';
import type { SqlFragment } from './sql.js';

// DATE columns stay 'YYYY-MM-DD' strings: converting to JS Date shifts them by the server timezone.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);
// NUMERIC stays a string (default); money arithmetic happens in integer paise, never floats.

export type Db = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10 });
}

export async function query<T extends pg.QueryResultRow>(db: Db, fragment: SqlFragment): Promise<T[]> {
  const { text, values } = fragment.toQuery();
  const result = await db.query<T>(text, values);
  return result.rows;
}

export async function queryOne<T extends pg.QueryResultRow>(
  db: Db,
  fragment: SqlFragment,
): Promise<T | undefined> {
  const rows = await query<T>(db, fragment);
  return rows[0];
}

/** Runs fn in a transaction. Business mutations + outbox + audit go through here together. */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
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
