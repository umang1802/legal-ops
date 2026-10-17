import type { CourtDto } from '@legalops/types';
import type { CreateCourtInput } from '@legalops/validation';
import { query, queryOne, withTransaction, type Db } from '../../db/pool.js';
import { sql } from '../../db/sql.js';
import type { Deps } from '../../deps.js';
import type { RequestMeta, TenantContext } from '../../http/context.js';
import { conflict, validationError } from '../../http/errors.js';
import { likeContains } from '../../http/query-helpers.js';
import { recordAudit } from '../audit/audit.service.js';

type CourtRow = {
  id: string;
  name: string;
  court_type: string | null;
  city: string | null;
  state: string | null;
  organization_id: string | null;
};

const toDto = (c: CourtRow): CourtDto => ({
  id: c.id,
  name: c.name,
  courtType: c.court_type,
  city: c.city,
  state: c.state,
  isGlobal: c.organization_id === null,
});

export async function listCourts(deps: Deps, ctx: TenantContext, search?: string): Promise<CourtDto[]> {
  const rows = await query<CourtRow>(
    deps.pool,
    sql`SELECT id, name, court_type, city, state, organization_id FROM courts
        WHERE (organization_id IS NULL OR organization_id = ${ctx.organizationId})
          ${search ? sql`AND (name ILIKE ${likeContains(search)} OR city ILIKE ${likeContains(search)})` : sql.empty}
        ORDER BY (organization_id IS NULL), name
        LIMIT 50`,
  );
  return rows.map(toDto);
}

/** A court is usable when it's global or belongs to the caller's firm. */
export async function assertCourtUsable(
  db: Db,
  ctx: TenantContext,
  courtId: string,
): Promise<{ name: string }> {
  const row = await queryOne<{ name: string }>(
    db,
    sql`SELECT name FROM courts WHERE id = ${courtId} AND (organization_id IS NULL OR organization_id = ${ctx.organizationId})`,
  );
  if (!row)
    throw validationError('Choose a court from the list', [{ path: 'courtId', message: 'Unknown court' }]);
  return row;
}

export async function createCourt(
  deps: Deps,
  ctx: TenantContext,
  input: CreateCourtInput & { name: string },
  meta: RequestMeta,
): Promise<CourtDto> {
  return withTransaction(deps.pool, async (tx) => {
    const existing = await queryOne<CourtRow>(
      tx,
      sql`SELECT id, name, court_type, city, state, organization_id FROM courts
          WHERE lower(name) = lower(${input.name}) AND (organization_id IS NULL OR organization_id = ${ctx.organizationId})`,
    );
    if (existing) throw conflict(`“${existing.name}” is already in your court list`);
    const row = await queryOne<CourtRow>(
      tx,
      sql`INSERT INTO courts (organization_id, name, court_type, city, state)
          VALUES (${ctx.organizationId}, ${input.name}, ${input.courtType ?? null}, ${input.city ?? null}, ${input.state ?? null})
          RETURNING id, name, court_type, city, state, organization_id`,
    );
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'court.created',
      entityType: 'court',
      entityId: row!.id,
      after: row,
      meta,
    });
    return toDto(row!);
  });
}
