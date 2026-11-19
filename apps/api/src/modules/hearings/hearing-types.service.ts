import { HEARING_TYPES, type HearingTypeDto } from '@legalops/types';
import type { z } from 'zod';
import type { createHearingTypeSchema, updateHearingTypeSchema } from '@legalops/validation';
import { query, queryOne, withTransaction, type Db } from '../../db/pool.js';
import { sql } from '../../db/sql.js';
import type { Deps } from '../../deps.js';
import type { RequestMeta, TenantContext } from '../../http/context.js';
import { conflict, notFound, validationError } from '../../http/errors.js';
import { recordAudit } from '../audit/audit.service.js';

type Row = { id: string; name: string; is_active: boolean; position: number; in_use: number };

const toDto = (r: Row): HearingTypeDto => ({
  id: r.id,
  name: r.name,
  isActive: r.is_active,
  position: r.position,
  inUse: r.in_use,
});

/** A firm that has never had a list (created after the migration) gets the standard one, once. Safe to call repeatedly. */
export async function ensureDefaultHearingTypes(db: Db, organizationId: string): Promise<void> {
  const values = HEARING_TYPES.map((name, i) => sql`(${organizationId}::uuid, ${name}::text, ${i}::int)`);
  await query(
    db,
    sql`INSERT INTO hearing_types (organization_id, name, position)
        SELECT v.o, v.n, v.p FROM (VALUES ${sql.join(values)}) AS v(o, n, p)
        WHERE NOT EXISTS (SELECT 1 FROM hearing_types WHERE organization_id = ${organizationId})
        ON CONFLICT DO NOTHING`,
  );
}

const SELECT = sql`SELECT t.id, t.name, t.is_active, t.position,
                          (SELECT count(*)::int FROM hearings h WHERE h.organization_id = t.organization_id AND lower(h.hearing_type) = lower(t.name)) AS in_use
                   FROM hearing_types t`;

export async function listHearingTypes(deps: Deps, ctx: TenantContext): Promise<HearingTypeDto[]> {
  await ensureDefaultHearingTypes(deps.pool, ctx.organizationId);
  const rows = await query<Row>(
    deps.pool,
    sql`${SELECT} WHERE t.organization_id = ${ctx.organizationId} ORDER BY t.is_active DESC, t.position, lower(t.name)`,
  );
  return rows.map(toDto);
}

const duplicate = () => conflict('Your firm already has a hearing type with that name');

export async function createHearingType(
  deps: Deps,
  ctx: TenantContext,
  input: z.output<typeof createHearingTypeSchema>,
  meta: RequestMeta,
): Promise<HearingTypeDto> {
  return withTransaction(deps.pool, async (tx) => {
    await ensureDefaultHearingTypes(tx, ctx.organizationId);
    const existing = await queryOne<{ id: string; is_active: boolean }>(
      tx,
      sql`SELECT id, is_active FROM hearing_types WHERE organization_id = ${ctx.organizationId} AND lower(name) = lower(${input.name}) FOR UPDATE`,
    );
    if (existing?.is_active) throw duplicate();
    let id: string;
    if (existing) {
      // Adding back an archived name just brings it back, at the end of the list.
      id = existing.id;
      await query(
        tx,
        sql`UPDATE hearing_types SET is_active = true, name = ${input.name}, position = (SELECT COALESCE(max(position), 0) + 1 FROM hearing_types WHERE organization_id = ${ctx.organizationId}) WHERE id = ${id}`,
      );
    } else {
      const row = await queryOne<{ id: string }>(
        tx,
        sql`INSERT INTO hearing_types (organization_id, name, position, created_by)
            VALUES (${ctx.organizationId}, ${input.name}, (SELECT COALESCE(max(position), 0) + 1 FROM hearing_types WHERE organization_id = ${ctx.organizationId}), ${ctx.userId})
            RETURNING id`,
      );
      id = row!.id;
    }
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'hearing_type.created',
      entityType: 'hearing_type',
      entityId: id,
      after: { name: input.name },
      meta,
    });
    return toDto((await queryOne<Row>(tx, sql`${SELECT} WHERE t.id = ${id}`))!);
  });
}

export async function updateHearingType(
  deps: Deps,
  ctx: TenantContext,
  id: string,
  input: z.output<typeof updateHearingTypeSchema>,
  meta: RequestMeta,
): Promise<HearingTypeDto> {
  return withTransaction(deps.pool, async (tx) => {
    const before = await queryOne<{ name: string; is_active: boolean }>(
      tx,
      sql`SELECT name, is_active FROM hearing_types WHERE id = ${id} AND organization_id = ${ctx.organizationId} FOR UPDATE`,
    );
    if (!before) throw notFound('Hearing type');
    if (input.name !== undefined && input.name.toLowerCase() !== before.name.toLowerCase()) {
      const clash = await queryOne(
        tx,
        sql`SELECT 1 FROM hearing_types WHERE organization_id = ${ctx.organizationId} AND lower(name) = lower(${input.name}) AND id <> ${id}`,
      );
      if (clash) throw duplicate();
    }
    if (input.name !== undefined) {
      await query(tx, sql`UPDATE hearing_types SET name = ${input.name} WHERE id = ${id}`);
      // Hearings hold the type as text: carry the new name onto them so the diary and history stay consistent.
      if (input.name !== before.name) {
        await query(
          tx,
          sql`UPDATE hearings SET hearing_type = ${input.name} WHERE organization_id = ${ctx.organizationId} AND lower(hearing_type) = lower(${before.name})`,
        );
      }
    }
    if (input.isActive !== undefined)
      await query(tx, sql`UPDATE hearing_types SET is_active = ${input.isActive} WHERE id = ${id}`);
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'hearing_type.updated',
      entityType: 'hearing_type',
      entityId: id,
      before: { name: before.name, isActive: before.is_active },
      after: { name: input.name ?? before.name, isActive: input.isActive ?? before.is_active },
      meta,
    });
    return toDto((await queryOne<Row>(tx, sql`${SELECT} WHERE t.id = ${id}`))!);
  });
}

/** Sets the order from a full list of ids; ids that aren't this firm's are rejected, any it left out keep their place after the rest. */
export async function reorderHearingTypes(
  deps: Deps,
  ctx: TenantContext,
  ids: string[],
  meta: RequestMeta,
): Promise<HearingTypeDto[]> {
  await withTransaction(deps.pool, async (tx) => {
    const mine = await query<{ id: string }>(
      tx,
      sql`SELECT id FROM hearing_types WHERE organization_id = ${ctx.organizationId} ORDER BY position FOR UPDATE`,
    );
    const known = new Set(mine.map((r) => r.id));
    if (new Set(ids).size !== ids.length || ids.some((i) => !known.has(i))) {
      throw validationError('That list doesn’t match your hearing types. Refresh and try again.', [
        { path: 'ids', message: 'Unknown or repeated type' },
      ]);
    }
    const order = [...ids, ...mine.map((r) => r.id).filter((i) => !ids.includes(i))];
    for (const [pos, id] of order.entries())
      await query(tx, sql`UPDATE hearing_types SET position = ${pos} WHERE id = ${id}`);
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'hearing_type.reordered',
      entityType: 'hearing_type',
      entityId: null,
      meta,
    });
  });
  return listHearingTypes(deps, ctx);
}

/**
 * What a hearing may be saved with. Empty means "no type". Otherwise it must be one of the firm's active types (matched
 * ignoring case, saved as the firm spelled it). An existing hearing may keep a value it already has even if the firm has
 * since archived it, so editing the date of an old hearing never fails over its type.
 */
export async function resolveHearingType(
  db: Db,
  organizationId: string,
  value: string | null | undefined,
  current: string | null = null,
): Promise<string | null> {
  const wanted = value?.trim();
  if (!wanted) return null;
  await ensureDefaultHearingTypes(db, organizationId);
  const hit = await queryOne<{ name: string }>(
    db,
    sql`SELECT name FROM hearing_types WHERE organization_id = ${organizationId} AND is_active AND lower(name) = lower(${wanted})`,
  );
  if (hit) return hit.name;
  if (current && current.toLowerCase() === wanted.toLowerCase()) return current;
  throw validationError('Choose a hearing type from your firm’s list', [
    {
      path: 'hearingType',
      message: 'Not in your firm’s list. A partner can add it under Settings → Hearing types.',
    },
  ]);
}
