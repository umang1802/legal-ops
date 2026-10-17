import type { ClientDto, ClientListItemDto, DuplicateCandidate } from '@legalops/types';
import { normalizePhone, type UpdateClientInput, type listClientsSchema } from '@legalops/validation';
import type { z } from 'zod';
import { query, queryOne, withTransaction, type Db } from '../../db/pool.js';
import { sql } from '../../db/sql.js';
import type { Deps } from '../../deps.js';
import type { RequestMeta, TenantContext } from '../../http/context.js';
import { AppError, conflict, notFound } from '../../http/errors.js';
import { iso, likeContains, pageClause } from '../../http/query-helpers.js';
import { matterVisible } from '../access/matter-scope.js';
import { recordAudit } from '../audit/audit.service.js';
import { addTimelineEvent } from '../timeline/timeline.service.js';

/**
 * decisions.md D-007: the client directory (identity + contact) is firm-wide so anyone can run a
 * conflict check and avoid duplicates. Matters, and everything under them, stay assigned-only.
 */

type ClientRow = {
  id: string;
  client_type: ClientDto['clientType'];
  name: string;
  email: string | null;
  phone: string | null;
  alternate_phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  state_code: string | null;
  gstin: string | null;
  pan: string | null;
  notes: string | null;
  tags: string[];
  email_notifications_enabled: boolean;
  status: ClientDto['status'];
  created_at: Date;
  updated_at: Date;
};

const COLS = [
  'id',
  'client_type',
  'name',
  'email',
  'phone',
  'alternate_phone',
  'address',
  'city',
  'state',
  'state_code',
  'gstin',
  'pan',
  'notes',
  'tags',
  'email_notifications_enabled',
  'status',
  'created_at',
  'updated_at',
];
const CLIENT_COLUMNS = sql.raw(COLS.map((c) => `c.${c}`).join(', '));
const RETURNING_COLUMNS = sql.raw(COLS.join(', '));

const toDto = (c: ClientRow): ClientDto => ({
  id: c.id,
  clientType: c.client_type,
  name: c.name,
  email: c.email,
  phone: c.phone,
  alternatePhone: c.alternate_phone,
  address: c.address,
  city: c.city,
  state: c.state,
  stateCode: c.state_code,
  gstin: c.gstin,
  pan: c.pan,
  notes: c.notes,
  tags: c.tags,
  emailNotificationsEnabled: c.email_notifications_enabled,
  status: c.status,
  createdAt: iso(c.created_at)!,
  updatedAt: iso(c.updated_at)!,
});

const OPEN_MATTER = sql`m.status IN ('lead', 'active', 'on_hold')`;

export async function listClients(
  deps: Deps,
  ctx: TenantContext,
  f: z.output<typeof listClientsSchema>,
): Promise<{ items: ClientListItemDto[]; total: number }> {
  const search = f.search
    ? (() => {
        const phone = f.search.replace(/\D/g, '');
        return sql`AND (c.name ILIKE ${likeContains(f.search)} OR c.email ILIKE ${likeContains(f.search)}
                   ${phone.length >= 4 ? sql`OR c.phone_e164 LIKE ${likeContains(phone)}` : sql.empty})`;
      })()
    : sql.empty;
  const status = f.status === 'all' ? sql.empty : sql`AND c.status = ${f.status}`;
  const rows = await query<
    Pick<ClientRow, 'id' | 'client_type' | 'name' | 'email' | 'phone' | 'status' | 'city'> & {
      active_matter_count: number;
      total: number;
    }
  >(
    deps.pool,
    sql`SELECT c.id, c.client_type, c.name, c.email, c.phone, c.status, c.city,
               (SELECT count(*)::int FROM matters m
                 WHERE m.organization_id = c.organization_id AND m.client_id = c.id AND ${OPEN_MATTER}
                   AND ${matterVisible(ctx, sql.raw('m.id'))}) AS active_matter_count,
               count(*) OVER ()::int AS total
        FROM clients c
        WHERE c.organization_id = ${ctx.organizationId} ${status} ${search}
        ORDER BY c.name, c.id
        ${pageClause(f)}`,
  );
  return {
    total: rows[0]?.total ?? 0,
    items: rows.map((r) => ({
      id: r.id,
      clientType: r.client_type,
      name: r.name,
      email: r.email,
      phone: r.phone,
      status: r.status,
      city: r.city,
      activeMatterCount: r.active_matter_count,
    })),
  };
}

async function loadClient(db: Db, ctx: TenantContext, id: string, lock = false): Promise<ClientRow> {
  const row = await queryOne<ClientRow>(
    db,
    sql`SELECT ${CLIENT_COLUMNS} FROM clients c
        WHERE c.id = ${id} AND c.organization_id = ${ctx.organizationId} ${lock ? sql`FOR UPDATE` : sql.empty}`,
  );
  if (!row) throw notFound('Client');
  return row;
}

export async function getClient(deps: Deps, ctx: TenantContext, id: string): Promise<ClientDto> {
  return toDto(await loadClient(deps.pool, ctx, id));
}

export async function findDuplicates(
  db: Db,
  organizationId: string,
  probe: { name: string; email?: string | null; phone?: string | null },
  excludeId?: string,
): Promise<DuplicateCandidate[]> {
  const phoneE164 = probe.phone ? normalizePhone(probe.phone) : null;
  const rows = await query<{
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    email_match: boolean;
    phone_match: boolean;
    name_match: boolean;
  }>(
    db,
    sql`SELECT id, name, email, phone,
               (${probe.email ?? null}::citext IS NOT NULL AND email = ${probe.email ?? null}::citext) AS email_match,
               (${phoneE164}::text IS NOT NULL AND phone_e164 = ${phoneE164}) AS phone_match,
               (lower(name) = lower(${probe.name}) OR similarity(name, ${probe.name}) > 0.6) AS name_match
        FROM clients
        WHERE organization_id = ${organizationId} AND status <> 'archived'
          ${excludeId ? sql`AND id <> ${excludeId}` : sql.empty}
          AND ((${probe.email ?? null}::citext IS NOT NULL AND email = ${probe.email ?? null}::citext)
               OR (${phoneE164}::text IS NOT NULL AND phone_e164 = ${phoneE164})
               OR lower(name) = lower(${probe.name})
               OR similarity(name, ${probe.name}) > 0.6)
        ORDER BY similarity(name, ${probe.name}) DESC
        LIMIT 5`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    matchedOn: [
      ...(r.email_match ? (['email'] as const) : []),
      ...(r.phone_match ? (['phone'] as const) : []),
      ...(r.name_match ? (['name'] as const) : []),
    ],
  }));
}

type ClientWrite = {
  clientType?: ClientDto['clientType'] | undefined;
  name?: string | undefined;
  email?: string | null | undefined;
  phone?: string | null | undefined;
  alternatePhone?: string | null | undefined;
  address?: string | null | undefined;
  city?: string | null | undefined;
  state?: string | null | undefined;
  stateCode?: string | null | undefined;
  gstin?: string | null | undefined;
  pan?: string | null | undefined;
  notes?: string | null | undefined;
  tags?: string[] | undefined;
  emailNotificationsEnabled?: boolean | undefined;
  status?: 'active' | 'inactive' | undefined;
};

const COLUMN: Record<keyof ClientWrite, string> = {
  clientType: 'client_type',
  name: 'name',
  email: 'email',
  phone: 'phone',
  alternatePhone: 'alternate_phone',
  address: 'address',
  city: 'city',
  state: 'state',
  stateCode: 'state_code',
  gstin: 'gstin',
  pan: 'pan',
  notes: 'notes',
  tags: 'tags',
  emailNotificationsEnabled: 'email_notifications_enabled',
  status: 'status',
};

export async function createClient(
  deps: Deps,
  ctx: TenantContext,
  input: ClientWrite & { name: string; acknowledgeDuplicates: boolean },
  meta: RequestMeta,
): Promise<ClientDto> {
  return withTransaction(deps.pool, async (tx) => {
    if (!input.acknowledgeDuplicates) {
      const dupes = await findDuplicates(tx, ctx.organizationId, input);
      if (dupes.length > 0) {
        throw new AppError(409, 'DUPLICATE_WARNING', 'A similar client already exists', dupes);
      }
    }
    const { acknowledgeDuplicates: _ack, ...fields } = input;
    const keys = (Object.keys(fields) as (keyof ClientWrite)[]).filter((k) => fields[k] !== undefined);
    const row = await queryOne<ClientRow>(
      tx,
      sql`INSERT INTO clients (organization_id, created_by, phone_e164, ${sql.raw(keys.map((k) => COLUMN[k]).join(', '))})
          VALUES (${ctx.organizationId}, ${ctx.userId}, ${fields.phone ? normalizePhone(fields.phone) : null},
                  ${sql.join(keys.map((k) => sql`${fields[k]}`))})
          RETURNING ${RETURNING_COLUMNS}`,
    );
    const client = row!;
    await addTimelineEvent(tx, {
      organizationId: ctx.organizationId,
      clientId: client.id,
      eventType: 'client.created',
      title: `Client ${client.name} added`,
      actorUserId: ctx.userId,
    });
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: input.acknowledgeDuplicates ? 'client.created_despite_duplicate' : 'client.created',
      entityType: 'client',
      entityId: client.id,
      after: client,
      meta,
    });
    return toDto(client);
  });
}

export async function updateClient(
  deps: Deps,
  ctx: TenantContext,
  id: string,
  input: UpdateClientInput & ClientWrite,
  meta: RequestMeta,
): Promise<ClientDto> {
  return withTransaction(deps.pool, async (tx) => {
    const before = await loadClient(tx, ctx, id, true);
    if (before.status === 'archived') throw conflict('Archived clients cannot be edited');
    const keys = (Object.keys(input) as (keyof ClientWrite)[]).filter(
      (k) => k in COLUMN && input[k] !== undefined,
    );
    if (keys.length > 0) {
      const sets = keys.map((k) => sql`${sql.raw(COLUMN[k])} = ${input[k]}`);
      if (input.phone !== undefined)
        sets.push(sql`phone_e164 = ${input.phone ? normalizePhone(input.phone) : null}`);
      await query(
        tx,
        sql`UPDATE clients SET ${sql.join(sets)} WHERE id = ${id} AND organization_id = ${ctx.organizationId}`,
      );
    }
    const after = await loadClient(tx, ctx, id);
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'client.updated',
      entityType: 'client',
      entityId: id,
      before,
      after,
      meta,
    });
    return toDto(after);
  });
}

/** Clients are never hard-deleted (they anchor matters and financial history). */
export async function archiveClient(
  deps: Deps,
  ctx: TenantContext,
  id: string,
  meta: RequestMeta,
): Promise<void> {
  await withTransaction(deps.pool, async (tx) => {
    const before = await loadClient(tx, ctx, id, true);
    const open = await queryOne<{ n: number }>(
      tx,
      sql`SELECT count(*)::int AS n FROM matters m
          WHERE m.organization_id = ${ctx.organizationId} AND m.client_id = ${id} AND ${OPEN_MATTER}`,
    );
    if ((open?.n ?? 0) > 0) throw conflict('Close or archive this client’s open matters first');
    await query(tx, sql`UPDATE clients SET status = 'archived' WHERE id = ${id}`);
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'client.archived',
      entityType: 'client',
      entityId: id,
      before: { status: before.status },
      after: { status: 'archived' },
      meta,
    });
  });
}
