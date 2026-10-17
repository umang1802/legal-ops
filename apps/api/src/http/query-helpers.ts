import { query, type Db } from '../db/pool.js';
import { sql, type SqlFragment } from '../db/sql.js';
import { validationError } from './errors.js';

export type Page = { page: number; pageSize: number };

export function pageClause({ page, pageSize }: Page): SqlFragment {
  return sql`LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
}

/** ILIKE pattern for "contains", with user-supplied wildcards escaped. */
export function likeContains(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** Throws 422 unless every id is an active member of the org. Used for assignees/staff. */
export async function assertActiveMembers(
  db: Db,
  organizationId: string,
  userIds: readonly string[],
  field: string,
  allowedRoles?: readonly string[],
): Promise<void> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return;
  const rows = await query<{ user_id: string; role: string }>(
    db,
    sql`SELECT user_id, role FROM organization_members
        WHERE organization_id = ${organizationId} AND status = 'active' AND user_id = ANY(${unique}::uuid[])`,
  );
  const ok = rows.filter((r) => !allowedRoles || allowedRoles.includes(r.role));
  if (ok.length !== unique.length) {
    throw validationError('Choose an active member of your firm', [
      { path: field, message: 'Not an eligible member' },
    ]);
  }
}
