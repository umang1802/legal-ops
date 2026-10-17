import {
  MATTER_STATUS_LABELS,
  seesAllMatters,
  type MatterDetailDto,
  type MatterListItemDto,
  type MatterStaffRole,
  type UserRef,
} from '@legalops/types';
import type { createMatterSchema, listMattersSchema, updateMatterSchema } from '@legalops/validation';
import type { z } from 'zod';
import { query, queryOne, withTransaction, type Db } from '../../db/pool.js';
import { sql } from '../../db/sql.js';
import type { Deps } from '../../deps.js';
import type { RequestMeta, TenantContext } from '../../http/context.js';
import { conflict, notFound, validationError } from '../../http/errors.js';
import { assertActiveMembers, iso, likeContains, pageClause } from '../../http/query-helpers.js';
import { assertMatterVisible, matterVisible } from '../access/matter-scope.js';
import { recordAudit } from '../audit/audit.service.js';
import { createCaseInTx, listCaseSummaries } from '../cases/cases.service.js';
import { emitEvent } from '../outbox/outbox.service.js';
import { addTimelineEvent } from '../timeline/timeline.service.js';

const LEAD_ROLES = ['owner', 'admin', 'lawyer'] as const;

type MatterRow = {
  id: string;
  title: string;
  reference_code: string | null;
  practice_area: string | null;
  status: MatterListItemDto['status'];
  priority: MatterListItemDto['priority'];
  client_id: string;
  client_name: string;
  lead_user_id: string | null;
  lead_first_name: string | null;
  lead_last_name: string | null;
  next_hearing_date: string | null;
  updated_at: Date;
};

const leadRef = (r: MatterRow): UserRef | null =>
  r.lead_user_id
    ? { userId: r.lead_user_id, firstName: r.lead_first_name ?? '', lastName: r.lead_last_name }
    : null;

/** Select list shared by list + detail. `today` is the firm's local date (org timezone), not the server's. */
const MATTER_SELECT = sql`
  m.id, m.title, m.reference_code, m.practice_area, m.status, m.priority, m.updated_at,
  c.id AS client_id, c.name AS client_name,
  lead.user_id AS lead_user_id, lu.first_name AS lead_first_name, lu.last_name AS lead_last_name,
  (SELECT min(h.scheduled_date)::text FROM hearings h JOIN cases cs ON cs.id = h.case_id
    WHERE cs.matter_id = m.id AND h.status = 'scheduled'
      AND h.scheduled_date >= (now() AT TIME ZONE o.timezone)::date) AS next_hearing_date`;

const MATTER_FROM = sql`
  matters m
  JOIN organizations o ON o.id = m.organization_id
  JOIN clients c ON c.id = m.client_id AND c.organization_id = m.organization_id
  LEFT JOIN matter_staff lead ON lead.matter_id = m.id AND lead.role = 'lead'
  LEFT JOIN users lu ON lu.id = lead.user_id`;

export async function listMatters(
  deps: Deps,
  ctx: TenantContext,
  f: z.output<typeof listMattersSchema>,
): Promise<{ items: MatterListItemDto[]; total: number }> {
  const filters = [sql`m.organization_id = ${ctx.organizationId}`, matterVisible(ctx, sql.raw('m.id'))];
  if (f.status === 'open') filters.push(sql`m.status IN ('lead', 'active', 'on_hold')`);
  else if (f.status !== 'all') filters.push(sql`m.status = ${f.status}`);
  if (f.priority) filters.push(sql`m.priority = ${f.priority}`);
  if (f.practiceArea) filters.push(sql`m.practice_area = ${f.practiceArea}`);
  if (f.clientId) filters.push(sql`m.client_id = ${f.clientId}`);
  if (f.lawyerId) {
    filters.push(
      sql`EXISTS (SELECT 1 FROM matter_staff s WHERE s.matter_id = m.id AND s.user_id = ${f.lawyerId})`,
    );
  }
  if (f.search) {
    const p = likeContains(f.search);
    filters.push(sql`(m.title ILIKE ${p} OR m.reference_code ILIKE ${p} OR c.name ILIKE ${p}
      OR EXISTS (SELECT 1 FROM cases s WHERE s.matter_id = m.id AND (s.case_number ILIKE ${p} OR s.cnr ILIKE ${p})))`);
  }

  const rows = await query<
    MatterRow & {
      case_count: number;
      pc_id: string | null;
      pc_case_number: string | null;
      pc_cnr: string | null;
      pc_court: string | null;
      total: number;
    }
  >(
    deps.pool,
    sql`SELECT ${MATTER_SELECT},
               (SELECT count(*)::int FROM cases cs WHERE cs.matter_id = m.id) AS case_count,
               pc.id AS pc_id, pc.case_number AS pc_case_number, pc.cnr AS pc_cnr, pc.court_name AS pc_court,
               count(*) OVER ()::int AS total
        FROM ${MATTER_FROM}
        LEFT JOIN LATERAL (
          SELECT cs.id, cs.case_number, cs.cnr, ct.name AS court_name FROM cases cs
          LEFT JOIN courts ct ON ct.id = cs.court_id
          WHERE cs.matter_id = m.id ORDER BY cs.created_at LIMIT 1
        ) pc ON TRUE
        WHERE ${sql.join(filters, ' AND ')}
        ORDER BY m.updated_at DESC, m.id
        ${pageClause(f)}`,
  );
  return {
    total: rows[0]?.total ?? 0,
    items: rows.map((r) => ({
      id: r.id,
      title: r.title,
      referenceCode: r.reference_code,
      practiceArea: r.practice_area,
      status: r.status,
      priority: r.priority,
      client: { id: r.client_id, name: r.client_name },
      lead: leadRef(r),
      primaryCase: r.pc_id
        ? { id: r.pc_id, caseNumber: r.pc_case_number, cnr: r.pc_cnr, courtName: r.pc_court }
        : null,
      caseCount: r.case_count,
      nextHearingDate: r.next_hearing_date,
      updatedAt: iso(r.updated_at)!,
    })),
  };
}

export async function getMatter(db: Db, ctx: TenantContext, matterId: string): Promise<MatterDetailDto> {
  const row = await queryOne<
    MatterRow & {
      start_date: string | null;
      close_date: string | null;
      internal_notes: string | null;
      client_summary: string | null;
      tags: string[];
      created_at: Date;
    }
  >(
    db,
    sql`SELECT ${MATTER_SELECT}, m.start_date, m.close_date, m.internal_notes, m.client_summary, m.tags, m.created_at
        FROM ${MATTER_FROM}
        WHERE m.id = ${matterId} AND m.organization_id = ${ctx.organizationId} AND ${matterVisible(ctx, sql.raw('m.id'))}`,
  );
  if (!row) throw notFound('Matter');
  const staff = await query<{
    user_id: string;
    first_name: string;
    last_name: string | null;
    role: MatterStaffRole;
  }>(
    db,
    sql`SELECT s.user_id, u.first_name, u.last_name, s.role FROM matter_staff s JOIN users u ON u.id = s.user_id
        WHERE s.matter_id = ${matterId}
        ORDER BY CASE s.role WHEN 'lead' THEN 0 WHEN 'associate' THEN 1 ELSE 2 END, u.first_name`,
  );
  return {
    id: row.id,
    title: row.title,
    referenceCode: row.reference_code,
    practiceArea: row.practice_area,
    status: row.status,
    priority: row.priority,
    client: { id: row.client_id, name: row.client_name },
    lead: leadRef(row),
    nextHearingDate: row.next_hearing_date,
    updatedAt: iso(row.updated_at)!,
    startDate: row.start_date,
    closeDate: row.close_date,
    internalNotes: row.internal_notes,
    clientSummary: row.client_summary,
    tags: row.tags,
    staff: staff.map((s) => ({
      userId: s.user_id,
      firstName: s.first_name,
      lastName: s.last_name,
      role: s.role,
    })),
    cases: await listCaseSummaries(db, ctx, matterId),
    createdAt: iso(row.created_at)!,
  };
}

export async function createMatter(
  deps: Deps,
  ctx: TenantContext,
  input: z.output<typeof createMatterSchema>,
  meta: RequestMeta,
): Promise<MatterDetailDto> {
  return withTransaction(deps.pool, async (tx) => {
    const client = await queryOne<{ id: string; name: string; status: string }>(
      tx,
      sql`SELECT id, name, status FROM clients WHERE id = ${input.clientId} AND organization_id = ${ctx.organizationId}`,
    );
    if (!client) throw validationError('Choose a client', [{ path: 'clientId', message: 'Unknown client' }]);
    if (client.status === 'archived') throw conflict('This client is archived');

    // Assignment plan. Creators who only see assigned matters are always put on the matter,
    // otherwise they'd create something they can immediately no longer see.
    const staff = new Map<string, MatterStaffRole>();
    if (input.leadUserId) staff.set(input.leadUserId, 'lead');
    for (const id of input.staffUserIds) if (!staff.has(id)) staff.set(id, 'support');
    if (!seesAllMatters(ctx.role) && !staff.has(ctx.userId)) {
      staff.set(ctx.userId, ctx.role === 'lawyer' && !input.leadUserId ? 'lead' : 'support');
    }
    if (input.leadUserId)
      await assertActiveMembers(tx, ctx.organizationId, [input.leadUserId], 'leadUserId', LEAD_ROLES);
    await assertActiveMembers(tx, ctx.organizationId, [...staff.keys()], 'staffUserIds');

    const matter = await queryOne<{ id: string }>(
      tx,
      sql`INSERT INTO matters (organization_id, client_id, title, reference_code, practice_area, status, priority,
                               start_date, internal_notes, client_summary, tags, created_by)
          VALUES (${ctx.organizationId}, ${input.clientId}, ${input.title}, ${input.referenceCode ?? null},
                  ${input.practiceArea ?? null}, ${input.status}, ${input.priority}, ${input.startDate ?? null},
                  ${input.internalNotes ?? null}, ${input.clientSummary ?? null}, ${input.tags}, ${ctx.userId})
          RETURNING id`,
    );
    const matterId = matter!.id;
    for (const [userId, role] of staff) {
      await query(
        tx,
        sql`INSERT INTO matter_staff (organization_id, matter_id, user_id, role, added_by)
            VALUES (${ctx.organizationId}, ${matterId}, ${userId}, ${role}, ${ctx.userId})`,
      );
    }
    await addTimelineEvent(tx, {
      organizationId: ctx.organizationId,
      matterId,
      clientId: input.clientId,
      eventType: 'matter.created',
      title: 'Matter opened',
      description: `${input.title} for ${client.name}`,
      actorUserId: ctx.userId,
    });
    await emitEvent(tx, {
      organizationId: ctx.organizationId,
      eventType: 'MATTER_CREATED',
      aggregateType: 'matter',
      aggregateId: matterId,
      payload: { matterId, clientId: input.clientId },
      actorUserId: ctx.userId,
    });
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'matter.created',
      entityType: 'matter',
      entityId: matterId,
      after: { ...input, staff: Object.fromEntries(staff) },
      meta,
    });
    if (input.initialCase) {
      await createCaseInTx(tx, ctx, { ...input.initialCase, matterId }, meta);
    }
    return getMatter(tx, ctx, matterId);
  });
}

const MATTER_COLUMNS: Record<keyof z.output<typeof updateMatterSchema>, string> = {
  title: 'title',
  referenceCode: 'reference_code',
  practiceArea: 'practice_area',
  status: 'status',
  priority: 'priority',
  startDate: 'start_date',
  closeDate: 'close_date',
  internalNotes: 'internal_notes',
  clientSummary: 'client_summary',
  tags: 'tags',
};

export async function updateMatter(
  deps: Deps,
  ctx: TenantContext,
  matterId: string,
  input: z.output<typeof updateMatterSchema>,
  meta: RequestMeta,
): Promise<MatterDetailDto> {
  return withTransaction(deps.pool, async (tx) => {
    await assertMatterVisible(tx, ctx, matterId);
    const before = await queryOne<
      Record<string, unknown> & { status: keyof typeof MATTER_STATUS_LABELS; close_date: string | null }
    >(tx, sql`SELECT * FROM matters WHERE id = ${matterId} FOR UPDATE`);
    const changes = { ...input };
    // Closing a matter stamps today's date (firm timezone) unless one was given.
    if (
      changes.status === 'closed' &&
      before!.status !== 'closed' &&
      changes.closeDate === undefined &&
      !before!.close_date
    ) {
      const today = await queryOne<{ d: string }>(
        tx,
        sql`SELECT ((now() AT TIME ZONE timezone)::date)::text AS d FROM organizations WHERE id = ${ctx.organizationId}`,
      );
      changes.closeDate = today!.d;
    }
    const keys = (Object.keys(changes) as (keyof typeof changes)[]).filter((k) => changes[k] !== undefined);
    if (keys.length > 0) {
      await query(
        tx,
        sql`UPDATE matters SET ${sql.join(keys.map((k) => sql`${sql.raw(MATTER_COLUMNS[k])} = ${changes[k]}`))}
            WHERE id = ${matterId} AND organization_id = ${ctx.organizationId}`,
      );
    }
    if (changes.status && changes.status !== before!.status) {
      await addTimelineEvent(tx, {
        organizationId: ctx.organizationId,
        matterId,
        eventType: 'matter.status_changed',
        title: `Status changed to ${MATTER_STATUS_LABELS[changes.status]}`,
        description: `Was ${MATTER_STATUS_LABELS[before!.status]}`,
        actorUserId: ctx.userId,
      });
    }
    const after = await queryOne(tx, sql`SELECT * FROM matters WHERE id = ${matterId}`);
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'matter.updated',
      entityType: 'matter',
      entityId: matterId,
      before,
      after,
      meta,
    });
    return getMatter(tx, ctx, matterId);
  });
}

export async function addMatterStaff(
  deps: Deps,
  ctx: TenantContext,
  matterId: string,
  input: { userId: string; role: MatterStaffRole },
  meta: RequestMeta,
): Promise<MatterDetailDto> {
  return withTransaction(deps.pool, async (tx) => {
    await assertMatterVisible(tx, ctx, matterId);
    await assertActiveMembers(
      tx,
      ctx.organizationId,
      [input.userId],
      'userId',
      input.role === 'lead' ? LEAD_ROLES : undefined,
    );
    await query(tx, sql`SELECT 1 FROM matters WHERE id = ${matterId} FOR UPDATE`);
    if (input.role === 'lead') {
      await query(
        tx,
        sql`UPDATE matter_staff SET role = 'associate' WHERE matter_id = ${matterId} AND role = 'lead' AND user_id <> ${input.userId}`,
      );
    }
    await query(
      tx,
      sql`INSERT INTO matter_staff (organization_id, matter_id, user_id, role, added_by)
          VALUES (${ctx.organizationId}, ${matterId}, ${input.userId}, ${input.role}, ${ctx.userId})
          ON CONFLICT (matter_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    );
    const user = await queryOne<{ first_name: string; last_name: string | null }>(
      tx,
      sql`SELECT first_name, last_name FROM users WHERE id = ${input.userId}`,
    );
    await addTimelineEvent(tx, {
      organizationId: ctx.organizationId,
      matterId,
      eventType: 'matter.staff_assigned',
      title:
        `${user!.first_name} ${user!.last_name ?? ''}`.trim() +
        (input.role === 'lead' ? ' is now lead lawyer' : ' assigned'),
      actorUserId: ctx.userId,
    });
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'matter.staff_assigned',
      entityType: 'matter',
      entityId: matterId,
      after: input,
      meta,
    });
    return getMatter(tx, ctx, matterId);
  });
}

export async function removeMatterStaff(
  deps: Deps,
  ctx: TenantContext,
  matterId: string,
  userId: string,
  meta: RequestMeta,
): Promise<void> {
  await withTransaction(deps.pool, async (tx) => {
    await assertMatterVisible(tx, ctx, matterId);
    const removed = await queryOne<{ role: string }>(
      tx,
      sql`DELETE FROM matter_staff WHERE matter_id = ${matterId} AND user_id = ${userId} RETURNING role`,
    );
    if (!removed) throw notFound('Assignment');
    const user = await queryOne<{ first_name: string; last_name: string | null }>(
      tx,
      sql`SELECT first_name, last_name FROM users WHERE id = ${userId}`,
    );
    await addTimelineEvent(tx, {
      organizationId: ctx.organizationId,
      matterId,
      eventType: 'matter.staff_removed',
      title: `${`${user?.first_name ?? ''} ${user?.last_name ?? ''}`.trim()} unassigned`,
      actorUserId: ctx.userId,
    });
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'matter.staff_removed',
      entityType: 'matter',
      entityId: matterId,
      before: { userId, role: removed.role },
      meta,
    });
  });
}
