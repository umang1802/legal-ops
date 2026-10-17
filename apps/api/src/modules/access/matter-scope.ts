import { seesAllMatters } from '@legalops/types';
import { queryOne, type Db } from '../../db/pool.js';
import { sql, type SqlFragment } from '../../db/sql.js';
import { notFound } from '../../http/errors.js';
import type { TenantContext } from '../../http/context.js';

/**
 * THE single place matter visibility is decided (decisions.md D-004).
 * owner/admin/finance: every matter in the org. lawyer/staff/read_only: matters they're on via matter_staff.
 *
 * Usage: sql`SELECT ... FROM matters m WHERE m.organization_id = ${ctx.organizationId} AND ${matterVisible(ctx, sql.raw('m.id'))}`
 * Every query touching matter-owned data (cases, hearings, tasks, documents, invoices) must AND this in.
 */
export function matterVisible(
  ctx: TenantContext,
  matterIdColumn: SqlFragment | ReturnType<typeof sql.raw>,
): SqlFragment {
  if (seesAllMatters(ctx.role)) return sql`TRUE`;
  return sql`${matterIdColumn} IN (
    SELECT ms.matter_id FROM matter_staff ms
    WHERE ms.organization_id = ${ctx.organizationId} AND ms.user_id = ${ctx.userId})`;
}

/**
 * Throws 404 (not 403) when the matter is outside the caller's org or assignment, so the response
 * never confirms that a matter exists.
 */
export async function assertMatterVisible(db: Db, ctx: TenantContext, matterId: string): Promise<void> {
  const row = await queryOne<{ id: string }>(
    db,
    sql`SELECT m.id FROM matters m
        WHERE m.id = ${matterId} AND m.organization_id = ${ctx.organizationId}
          AND ${matterVisible(ctx, sql.raw('m.id'))}`,
  );
  if (!row) throw notFound('Matter');
}
