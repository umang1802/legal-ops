import { queryOne, type Db } from '../db/pool.js';
import { sql } from '../db/sql.js';

/** The firm's local calendar date (organizations.timezone), never the server's. */
export async function orgToday(db: Db, organizationId: string): Promise<string> {
  const row = await queryOne<{ d: string }>(
    db,
    sql`SELECT ((now() AT TIME ZONE timezone)::date)::text AS d FROM organizations WHERE id = ${organizationId}`,
  );
  return row!.d;
}

/** SQL expression for the firm's local date, for use inside larger queries. */
export const orgTodaySql = (orgIdColumn: string) =>
  sql`(SELECT (now() AT TIME ZONE tz_o.timezone)::date FROM organizations tz_o WHERE tz_o.id = ${sql.raw(orgIdColumn)})`;

/** '2026-10-10' -> '10 Oct 2026' (calendar dates carry no timezone). */
export function displayDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y!, m! - 1, d!)));
}
