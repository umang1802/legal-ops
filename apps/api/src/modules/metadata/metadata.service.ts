import { metadataList, type MetadataListKey, type MetadataOptionDto } from '@legalops/types';
import type { createMetadataOptionSchema, updateMetadataOptionSchema } from '@legalops/validation';
import type { z } from 'zod';
import { query, queryOne, withTransaction, type Db } from '../../db/pool.js';
import { sql } from '../../db/sql.js';
import type { Deps } from '../../deps.js';
import type { RequestMeta, TenantContext } from '../../http/context.js';
import { conflict, notFound, validationError } from '../../http/errors.js';
import { recordAudit } from '../audit/audit.service.js';

/** Where each list's chosen value is stored (as the entry's name). Trusted constants: they go into SQL as identifiers. */
const USAGE: Record<MetadataListKey, { table: string; column: string }> = {
  hearing_type: { table: 'hearings', column: 'hearing_type' },
  document_category: { table: 'documents', column: 'category' },
  practice_area: { table: 'matters', column: 'practice_area' },
  expense_category: { table: 'expenses', column: 'category' },
};

type Row = { id: string; name: string; is_active: boolean; position: number; in_use: number };
const toDto = (r: Row): MetadataOptionDto => ({
  id: r.id,
  name: r.name,
  isActive: r.is_active,
  position: r.position,
  inUse: r.in_use,
});

const def = (list: MetadataListKey) => metadataList(list)!;

/** A firm that has never had this list (created after the migration) gets the standard one, once. Safe to call repeatedly. */
export async function ensureDefaultOptions(
  db: Db,
  organizationId: string,
  list: MetadataListKey,
): Promise<void> {
  const values = def(list).defaults.map(
    (name, i) => sql`(${organizationId}::uuid, ${list}::text, ${name}::text, ${i}::int)`,
  );
  await query(
    db,
    sql`INSERT INTO metadata_options (organization_id, list_key, name, position)
        SELECT v.o, v.l, v.n, v.p FROM (VALUES ${sql.join(values)}) AS v(o, l, n, p)
        WHERE NOT EXISTS (SELECT 1 FROM metadata_options WHERE organization_id = ${organizationId} AND list_key = ${list})
        ON CONFLICT DO NOTHING`,
  );
}

const selectOptions = (list: MetadataListKey) => {
  const u = USAGE[list];
  return sql`SELECT o.id, o.name, o.is_active, o.position,
                    (SELECT count(*)::int FROM ${sql.raw(u.table)} r WHERE r.organization_id = o.organization_id AND lower(r.${sql.raw(u.column)}) = lower(o.name)) AS in_use
             FROM metadata_options o`;
};

export async function listOptions(
  deps: Deps,
  ctx: TenantContext,
  list: MetadataListKey,
): Promise<MetadataOptionDto[]> {
  await ensureDefaultOptions(deps.pool, ctx.organizationId, list);
  const rows = await query<Row>(
    deps.pool,
    sql`${selectOptions(list)} WHERE o.organization_id = ${ctx.organizationId} AND o.list_key = ${list} ORDER BY o.is_active DESC, o.position, lower(o.name)`,
  );
  return rows.map(toDto);
}

const duplicate = (list: MetadataListKey) =>
  conflict(`Your firm already has a ${def(list).singular} with that name`);

export async function createOption(
  deps: Deps,
  ctx: TenantContext,
  list: MetadataListKey,
  input: z.output<typeof createMetadataOptionSchema>,
  meta: RequestMeta,
): Promise<MetadataOptionDto> {
  return withTransaction(deps.pool, async (tx) => {
    await ensureDefaultOptions(tx, ctx.organizationId, list);
    const existing = await queryOne<{ id: string; is_active: boolean }>(
      tx,
      sql`SELECT id, is_active FROM metadata_options WHERE organization_id = ${ctx.organizationId} AND list_key = ${list} AND lower(name) = lower(${input.name}) FOR UPDATE`,
    );
    if (existing?.is_active) throw duplicate(list);
    const last = sql`(SELECT COALESCE(max(position), 0) + 1 FROM metadata_options WHERE organization_id = ${ctx.organizationId} AND list_key = ${list})`;
    let id: string;
    if (existing) {
      // Adding back an archived name just brings it back, at the end of the list.
      id = existing.id;
      await query(
        tx,
        sql`UPDATE metadata_options SET is_active = true, name = ${input.name}, position = ${last} WHERE id = ${id}`,
      );
    } else {
      const row = await queryOne<{ id: string }>(
        tx,
        sql`INSERT INTO metadata_options (organization_id, list_key, name, position, created_by) VALUES (${ctx.organizationId}, ${list}, ${input.name}, ${last}, ${ctx.userId}) RETURNING id`,
      );
      id = row!.id;
    }
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'metadata.created',
      entityType: 'metadata_option',
      entityId: id,
      after: { list, name: input.name },
      meta,
    });
    return toDto((await queryOne<Row>(tx, sql`${selectOptions(list)} WHERE o.id = ${id}`))!);
  });
}

export async function updateOption(
  deps: Deps,
  ctx: TenantContext,
  list: MetadataListKey,
  id: string,
  input: z.output<typeof updateMetadataOptionSchema>,
  meta: RequestMeta,
): Promise<MetadataOptionDto> {
  return withTransaction(deps.pool, async (tx) => {
    const before = await queryOne<{ name: string; is_active: boolean }>(
      tx,
      sql`SELECT name, is_active FROM metadata_options WHERE id = ${id} AND organization_id = ${ctx.organizationId} AND list_key = ${list} FOR UPDATE`,
    );
    if (!before) throw notFound(def(list).singular);
    if (input.name !== undefined && input.name.toLowerCase() !== before.name.toLowerCase()) {
      const clash = await queryOne(
        tx,
        sql`SELECT 1 FROM metadata_options WHERE organization_id = ${ctx.organizationId} AND list_key = ${list} AND lower(name) = lower(${input.name}) AND id <> ${id}`,
      );
      if (clash) throw duplicate(list);
    }
    if (input.name !== undefined) {
      await query(tx, sql`UPDATE metadata_options SET name = ${input.name} WHERE id = ${id}`);
      // Records hold the name as text: carry the new name onto them so history, printouts and reports stay consistent.
      if (input.name !== before.name) {
        const u = USAGE[list];
        await query(
          tx,
          sql`UPDATE ${sql.raw(u.table)} SET ${sql.raw(u.column)} = ${input.name} WHERE organization_id = ${ctx.organizationId} AND lower(${sql.raw(u.column)}) = lower(${before.name})`,
        );
      }
    }
    if (input.isActive !== undefined)
      await query(tx, sql`UPDATE metadata_options SET is_active = ${input.isActive} WHERE id = ${id}`);
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'metadata.updated',
      entityType: 'metadata_option',
      entityId: id,
      before: { list, name: before.name, isActive: before.is_active },
      after: { list, name: input.name ?? before.name, isActive: input.isActive ?? before.is_active },
      meta,
    });
    return toDto((await queryOne<Row>(tx, sql`${selectOptions(list)} WHERE o.id = ${id}`))!);
  });
}

/** Sets the order from a full list of ids; ids that aren't this list's are rejected, any left out keep their place after the rest. */
export async function reorderOptions(
  deps: Deps,
  ctx: TenantContext,
  list: MetadataListKey,
  ids: string[],
  meta: RequestMeta,
): Promise<MetadataOptionDto[]> {
  await withTransaction(deps.pool, async (tx) => {
    const mine = await query<{ id: string }>(
      tx,
      sql`SELECT id FROM metadata_options WHERE organization_id = ${ctx.organizationId} AND list_key = ${list} ORDER BY position FOR UPDATE`,
    );
    const known = new Set(mine.map((r) => r.id));
    if (new Set(ids).size !== ids.length || ids.some((i) => !known.has(i))) {
      throw validationError('That list doesn’t match yours. Refresh and try again.', [
        { path: 'ids', message: 'Unknown or repeated entry' },
      ]);
    }
    const order = [...ids, ...mine.map((r) => r.id).filter((i) => !ids.includes(i))];
    for (const [pos, id] of order.entries())
      await query(tx, sql`UPDATE metadata_options SET position = ${pos} WHERE id = ${id}`);
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'metadata.reordered',
      entityType: 'metadata_option',
      entityId: null,
      after: { list },
      meta,
    });
  });
  return listOptions(deps, ctx, list);
}

/**
 * What a record may be saved with for one of these fields. Empty means "none": every one of these fields is optional.
 * Otherwise it must be one of the firm's active entries (matched ignoring case, saved as the firm spells it). A record
 * may keep a value it already has even if the firm has since archived it, so editing something else on an old record
 * never fails over this field. `field` is the form field's name, for the error message.
 */
export async function resolveOption(
  db: Db,
  organizationId: string,
  list: MetadataListKey,
  value: string | null | undefined,
  field: string,
  current: string | null = null,
): Promise<string | null> {
  const wanted = value?.trim();
  if (!wanted) return null;
  await ensureDefaultOptions(db, organizationId, list);
  const hit = await queryOne<{ name: string }>(
    db,
    sql`SELECT name FROM metadata_options WHERE organization_id = ${organizationId} AND list_key = ${list} AND is_active AND lower(name) = lower(${wanted})`,
  );
  if (hit) return hit.name;
  if (current && current.toLowerCase() === wanted.toLowerCase()) return current;
  throw validationError(`Choose a ${def(list).singular} from your firm’s list`, [
    { path: field, message: 'Not in your firm’s list. A partner can add it under Settings → Metadata.' },
  ]);
}
