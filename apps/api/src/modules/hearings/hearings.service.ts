import { HEARING_STATUS_LABELS, type HearingDto, type HearingStatus } from '@legalops/types';
import type {
  completeHearingSchema,
  createHearingSchema,
  listHearingsSchema,
  updateHearingSchema,
} from '@legalops/validation';
import type { z } from 'zod';
import { query, queryOne, withTransaction, type Db } from '../../db/pool.js';
import { sql, type SqlFragment } from '../../db/sql.js';
import type { Deps } from '../../deps.js';
import type { RequestMeta, TenantContext } from '../../http/context.js';
import { displayDate, orgToday } from '../../http/dates.js';
import { conflict, notFound, validationError } from '../../http/errors.js';
import { iso } from '../../http/query-helpers.js';
import { matterVisible } from '../access/matter-scope.js';
import { recordAudit } from '../audit/audit.service.js';
import { loadVisibleCase } from '../cases/cases.service.js';
import { emitEvent } from '../outbox/outbox.service.js';
import { createTaskInTx } from '../tasks/tasks.service.js';
import { addTimelineEvent } from '../timeline/timeline.service.js';

type HearingRow = {
  id: string;
  case_id: string;
  case_number: string | null;
  case_title: string;
  matter_id: string;
  matter_title: string;
  client_id: string;
  client_name: string;
  court_name: string | null;
  scheduled_date: string;
  start_time: string | null;
  end_time: string | null;
  courtroom: string | null;
  bench_judge: string | null;
  hearing_type: string | null;
  status: HearingStatus;
  outcome: string | null;
  next_hearing_date: string | null;
  next_hearing_id: string | null;
  previous_hearing_id: string | null;
  notes: string | null;
  lead_user_id: string | null;
  lead_first_name: string | null;
  lead_last_name: string | null;
  pending_outcome: boolean;
  completed_at: Date | null;
  cancel_reason: string | null;
};

const HEARING_SELECT = sql`
  h.id, h.case_id, cs.case_number, cs.title AS case_title, m.id AS matter_id, m.title AS matter_title,
  cl.id AS client_id, cl.name AS client_name, ct.name AS court_name,
  h.scheduled_date::text AS scheduled_date, to_char(h.start_time, 'HH24:MI') AS start_time,
  to_char(h.end_time, 'HH24:MI') AS end_time, h.courtroom, h.bench_judge, h.hearing_type, h.status, h.outcome,
  h.next_hearing_date::text AS next_hearing_date, h.next_hearing_id, h.previous_hearing_id, h.notes,
  lead.user_id AS lead_user_id, lu.first_name AS lead_first_name, lu.last_name AS lead_last_name,
  (h.status = 'scheduled' AND h.scheduled_date < (now() AT TIME ZONE o.timezone)::date) AS pending_outcome,
  h.completed_at, h.cancel_reason`;

const HEARING_FROM = sql`
  hearings h
  JOIN organizations o ON o.id = h.organization_id
  JOIN cases cs ON cs.id = h.case_id
  JOIN matters m ON m.id = cs.matter_id
  JOIN clients cl ON cl.id = m.client_id
  LEFT JOIN courts ct ON ct.id = cs.court_id
  LEFT JOIN matter_staff lead ON lead.matter_id = m.id AND lead.role = 'lead'
  LEFT JOIN users lu ON lu.id = lead.user_id`;

export const toHearingDto = (r: HearingRow): HearingDto => ({
  id: r.id,
  caseId: r.case_id,
  caseNumber: r.case_number,
  caseTitle: r.case_title,
  matterId: r.matter_id,
  matterTitle: r.matter_title,
  clientName: r.client_name,
  courtName: r.court_name,
  scheduledDate: r.scheduled_date,
  startTime: r.start_time,
  endTime: r.end_time,
  courtroom: r.courtroom,
  benchJudge: r.bench_judge,
  hearingType: r.hearing_type,
  status: r.status,
  outcome: r.outcome,
  nextHearingDate: r.next_hearing_date,
  nextHearingId: r.next_hearing_id,
  previousHearingId: r.previous_hearing_id,
  notes: r.notes,
  lead: r.lead_user_id
    ? { userId: r.lead_user_id, firstName: r.lead_first_name ?? '', lastName: r.lead_last_name }
    : null,
  pendingOutcome: r.pending_outcome,
  completedAt: iso(r.completed_at),
  cancelReason: r.cancel_reason,
});

/** Visible hearings matching extra conditions. Shared by list, calendar and dashboard. */
export async function queryHearings(
  db: Db,
  ctx: TenantContext,
  where: SqlFragment[],
  order: SqlFragment = sql`h.scheduled_date, h.start_time NULLS LAST, cs.case_number`,
  limit = 500,
): Promise<HearingDto[]> {
  const rows = await query<HearingRow>(
    db,
    sql`SELECT ${HEARING_SELECT} FROM ${HEARING_FROM}
        WHERE ${sql.join([sql`h.organization_id = ${ctx.organizationId}`, matterVisible(ctx, sql.raw('m.id')), ...where], ' AND ')}
        ORDER BY ${order}
        LIMIT ${limit}`,
  );
  return rows.map(toHearingDto);
}

export async function listHearings(
  deps: Deps,
  ctx: TenantContext,
  f: z.output<typeof listHearingsSchema>,
): Promise<HearingDto[]> {
  const where: SqlFragment[] = [];
  let from = f.from;
  let until = f.until;
  // Without a range or a specific case/matter, default to the next 30 days.
  if (!from && !until && !f.caseId && !f.matterId) {
    from = await orgToday(deps.pool, ctx.organizationId);
    until = (await queryOne<{ d: string }>(deps.pool, sql`SELECT (${from}::date + 30)::text AS d`))!.d;
  }
  if (from) where.push(sql`h.scheduled_date >= ${from}`);
  if (until) where.push(sql`h.scheduled_date <= ${until}`);
  if (f.caseId) where.push(sql`h.case_id = ${f.caseId}`);
  if (f.matterId) where.push(sql`m.id = ${f.matterId}`);
  if (f.lawyerId)
    where.push(
      sql`EXISTS (SELECT 1 FROM matter_staff s WHERE s.matter_id = m.id AND s.user_id = ${f.lawyerId})`,
    );
  if (f.status === 'pending_outcome')
    where.push(sql`h.status = 'scheduled' AND h.scheduled_date < (now() AT TIME ZONE o.timezone)::date`);
  else if (f.status === 'active') where.push(sql`h.status <> 'cancelled'`);
  else if (f.status) where.push(sql`h.status = ${f.status}`);
  const order = f.matterId || f.caseId ? sql`h.scheduled_date DESC, h.start_time DESC NULLS LAST` : undefined;
  return queryHearings(deps.pool, ctx, where, order);
}

export async function getHearing(db: Db, ctx: TenantContext, id: string): Promise<HearingDto> {
  const [h] = await queryHearings(db, ctx, [sql`h.id = ${id}`]);
  if (!h) throw notFound('Hearing');
  return h;
}

/** Locks and returns a visible hearing's raw row, or 404. */
async function lockHearing(db: Db, ctx: TenantContext, id: string) {
  const row = await queryOne<{
    id: string;
    case_id: string;
    matter_id: string;
    client_id: string;
    case_label: string;
    status: HearingStatus;
    scheduled_date: string;
    start_time: string | null;
    courtroom: string | null;
    bench_judge: string | null;
  }>(
    db,
    sql`SELECT h.id, h.case_id, cs.matter_id, m.client_id, COALESCE(cs.case_number, cs.title) AS case_label, h.status,
               h.scheduled_date::text AS scheduled_date, to_char(h.start_time, 'HH24:MI') AS start_time,
               h.courtroom, h.bench_judge
        FROM hearings h JOIN cases cs ON cs.id = h.case_id JOIN matters m ON m.id = cs.matter_id
        WHERE h.id = ${id} AND h.organization_id = ${ctx.organizationId} AND ${matterVisible(ctx, sql.raw('m.id'))}
        FOR UPDATE OF h`,
  );
  if (!row) throw notFound('Hearing');
  return row;
}

/** Keeps the denormalised cases.next_hearing_date in step (for sorting/imports); reads derive it from hearings. */
async function syncCaseNextHearing(db: Db, caseId: string): Promise<void> {
  await query(
    db,
    sql`UPDATE cases cs SET next_hearing_date = (
          SELECT min(h.scheduled_date) FROM hearings h JOIN organizations o ON o.id = h.organization_id
          WHERE h.case_id = cs.id AND h.status = 'scheduled' AND h.scheduled_date >= (now() AT TIME ZONE o.timezone)::date)
        WHERE cs.id = ${caseId}`,
  );
}

const when = (date: string, time: string | null | undefined) =>
  `${displayDate(date)}${time ? ` at ${time}` : ''}`;

async function insertHearing(
  db: Db,
  ctx: TenantContext,
  h: {
    caseId: string;
    scheduledDate: string;
    startTime?: string | null | undefined;
    endTime?: string | null | undefined;
    courtroom?: string | null | undefined;
    benchJudge?: string | null | undefined;
    hearingType?: string | null | undefined;
    notes?: string | null | undefined;
    previousHearingId?: string | null;
  },
  c: { matter_id: string; client_id: string; label: string },
  meta: RequestMeta,
  sourceEventId?: string,
): Promise<string> {
  const row = await queryOne<{ id: string }>(
    db,
    sql`INSERT INTO hearings (organization_id, case_id, scheduled_date, start_time, end_time, courtroom, bench_judge,
                              hearing_type, notes, previous_hearing_id, created_by)
        VALUES (${ctx.organizationId}, ${h.caseId}, ${h.scheduledDate}, ${h.startTime ?? null}, ${h.endTime ?? null},
                ${h.courtroom ?? null}, ${h.benchJudge ?? null}, ${h.hearingType ?? null}, ${h.notes ?? null},
                ${h.previousHearingId ?? null}, ${ctx.userId})
        RETURNING id`,
  );
  const id = row!.id;
  await addTimelineEvent(db, {
    organizationId: ctx.organizationId,
    matterId: c.matter_id,
    caseId: h.caseId,
    clientId: c.client_id,
    eventType: 'hearing.scheduled',
    title: `Hearing scheduled: ${when(h.scheduledDate, h.startTime)}`,
    description: [c.label, h.hearingType, h.courtroom ? `Court room ${h.courtroom}` : null]
      .filter(Boolean)
      .join(' · '),
    actorUserId: ctx.userId,
    sourceType: 'hearing',
    sourceId: id,
    ...(sourceEventId ? { metadata: { sourceEventId } } : {}),
  });
  await emitEvent(db, {
    organizationId: ctx.organizationId,
    eventType: 'HEARING_SCHEDULED',
    aggregateType: 'hearing',
    aggregateId: id,
    payload: {
      hearingId: id,
      caseId: h.caseId,
      matterId: c.matter_id,
      scheduledDate: h.scheduledDate,
      startTime: h.startTime ?? null,
    },
    actorUserId: ctx.userId,
  });
  await recordAudit(db, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'hearing.created',
    entityType: 'hearing',
    entityId: id,
    after: h,
    meta,
  });
  return id;
}

export async function createHearing(
  deps: Deps,
  ctx: TenantContext,
  input: z.output<typeof createHearingSchema>,
  meta: RequestMeta,
): Promise<HearingDto> {
  return withTransaction(deps.pool, async (tx) => {
    const c = await loadVisibleCase(tx, ctx, input.caseId);
    const id = await insertHearing(
      tx,
      ctx,
      input,
      { matter_id: c.matter_id, client_id: c.client_id, label: c.case_number ?? c.title },
      meta,
    );
    await syncCaseNextHearing(tx, input.caseId);
    return getHearing(tx, ctx, id);
  });
}

const HEARING_COLUMNS = {
  scheduledDate: 'scheduled_date',
  startTime: 'start_time',
  endTime: 'end_time',
  courtroom: 'courtroom',
  benchJudge: 'bench_judge',
  hearingType: 'hearing_type',
  notes: 'notes',
} as const;

export async function updateHearing(
  deps: Deps,
  ctx: TenantContext,
  id: string,
  input: z.output<typeof updateHearingSchema>,
  meta: RequestMeta,
): Promise<HearingDto> {
  return withTransaction(deps.pool, async (tx) => {
    const before = await lockHearing(tx, ctx, id);
    if (before.status !== 'scheduled') {
      throw conflict(
        `This hearing is ${HEARING_STATUS_LABELS[before.status].toLowerCase()}; it can no longer be edited`,
      );
    }
    const keys = (Object.keys(input) as (keyof typeof input)[]).filter((k) => input[k] !== undefined);
    if (keys.length > 0) {
      await query(
        tx,
        sql`UPDATE hearings SET ${sql.join(keys.map((k) => sql`${sql.raw(HEARING_COLUMNS[k])} = ${input[k]}`))}
            WHERE id = ${id}`,
      );
    }
    const moved =
      (input.scheduledDate !== undefined && input.scheduledDate !== before.scheduled_date) ||
      (input.startTime !== undefined && input.startTime !== before.start_time);
    if (moved) {
      const after = {
        date: input.scheduledDate ?? before.scheduled_date,
        time: input.startTime !== undefined ? input.startTime : before.start_time,
      };
      await addTimelineEvent(tx, {
        organizationId: ctx.organizationId,
        matterId: before.matter_id,
        caseId: before.case_id,
        eventType: 'hearing.rescheduled',
        title: `Hearing moved to ${when(after.date, after.time)}`,
        description: `${before.case_label} · was ${when(before.scheduled_date, before.start_time)}`,
        actorUserId: ctx.userId,
        sourceType: 'hearing',
        sourceId: id,
      });
      // Reminder workflows (Phase 5) re-plan from this event.
      await emitEvent(tx, {
        organizationId: ctx.organizationId,
        eventType: 'HEARING_CHANGED',
        aggregateType: 'hearing',
        aggregateId: id,
        payload: {
          hearingId: id,
          caseId: before.case_id,
          matterId: before.matter_id,
          before: { scheduledDate: before.scheduled_date, startTime: before.start_time },
          after: { scheduledDate: after.date, startTime: after.time },
        },
        actorUserId: ctx.userId,
      });
    }
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'hearing.updated',
      entityType: 'hearing',
      entityId: id,
      before,
      after: input,
      meta,
    });
    await syncCaseNextHearing(tx, before.case_id);
    return getHearing(tx, ctx, id);
  });
}

/**
 * Journey C: record what happened, the next date and follow-up actions, all in one transaction.
 * Not replayable: a hearing that is no longer "scheduled" returns 409, so a retry can't double-create.
 */
export async function completeHearing(
  deps: Deps,
  ctx: TenantContext,
  id: string,
  input: z.output<typeof completeHearingSchema>,
  meta: RequestMeta,
): Promise<{ hearing: HearingDto; nextHearing: HearingDto | null; taskIds: string[] }> {
  return withTransaction(deps.pool, async (tx) => {
    const h = await lockHearing(tx, ctx, id);
    if (h.status !== 'scheduled') {
      throw conflict(`The outcome of this hearing was already recorded (${HEARING_STATUS_LABELS[h.status]})`);
    }
    if (input.nextHearingDate && input.nextHearingDate <= h.scheduled_date) {
      throw validationError('The next date must be after this hearing', [
        { path: 'nextHearingDate', message: `Must be after ${displayDate(h.scheduled_date)}` },
      ]);
    }
    const today = await orgToday(tx, ctx.organizationId);
    if (h.scheduled_date > today) {
      throw validationError('You can only record the outcome on or after the hearing date', [
        { path: 'result', message: `This hearing is on ${displayDate(h.scheduled_date)}` },
      ]);
    }

    await query(
      tx,
      sql`UPDATE hearings SET status = ${input.result}, outcome = ${input.outcome},
            notes = COALESCE(${input.notes ?? null}, notes), next_hearing_date = ${input.nextHearingDate ?? null},
            completed_at = now(), completed_by = ${ctx.userId}
          WHERE id = ${id}`,
    );
    const eventId = await emitEvent(tx, {
      organizationId: ctx.organizationId,
      eventType: 'HEARING_COMPLETED',
      aggregateType: 'hearing',
      aggregateId: id,
      payload: {
        hearingId: id,
        caseId: h.case_id,
        matterId: h.matter_id,
        result: input.result,
        nextHearingDate: input.nextHearingDate ?? null,
        nextActionCount: input.nextActions.length,
      },
      actorUserId: ctx.userId,
    });
    await addTimelineEvent(tx, {
      organizationId: ctx.organizationId,
      matterId: h.matter_id,
      caseId: h.case_id,
      clientId: h.client_id,
      eventType: 'hearing.completed',
      title:
        input.result === 'adjourned'
          ? `Hearing adjourned${input.nextHearingDate ? ` to ${displayDate(input.nextHearingDate)}` : ''}`
          : `Hearing held${input.nextHearingDate ? `, next date ${displayDate(input.nextHearingDate)}` : ''}`,
      description: `${h.case_label} · ${input.outcome}`,
      actorUserId: ctx.userId,
      sourceType: 'hearing',
      sourceId: id,
    });

    let nextId: string | null = null;
    if (input.nextHearingDate) {
      nextId = await insertHearing(
        tx,
        ctx,
        {
          caseId: h.case_id,
          scheduledDate: input.nextHearingDate,
          startTime: input.nextStartTime ?? null,
          // Same court room and bench are by far the common case; editable afterwards.
          courtroom: h.courtroom,
          benchJudge: h.bench_judge,
          previousHearingId: id,
        },
        { matter_id: h.matter_id, client_id: h.client_id, label: h.case_label },
        meta,
        eventId,
      );
      await query(tx, sql`UPDATE hearings SET next_hearing_id = ${nextId} WHERE id = ${id}`);
    }

    // Default assignee for follow-ups: the matter's lead lawyer, else whoever recorded the outcome.
    const lead = await queryOne<{ user_id: string }>(
      tx,
      sql`SELECT user_id FROM matter_staff WHERE matter_id = ${h.matter_id} AND role = 'lead'`,
    );
    const taskIds: string[] = [];
    for (const [i, action] of input.nextActions.entries()) {
      taskIds.push(
        await createTaskInTx(
          tx,
          ctx,
          {
            title: action.title,
            matterId: h.matter_id,
            caseId: h.case_id,
            hearingId: id,
            assigneeId: action.assigneeId ?? lead?.user_id ?? ctx.userId,
            dueDate: action.dueDate ?? null,
            priority: 'normal',
          },
          meta,
          { sourceEventId: eventId ?? null, idempotencyKey: `hearing:${id}:action:${i}` },
        ),
      );
    }

    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'hearing.completed',
      entityType: 'hearing',
      entityId: id,
      before: { status: h.status },
      after: { ...input, nextHearingId: nextId },
      meta,
    });
    await syncCaseNextHearing(tx, h.case_id);
    return {
      hearing: await getHearing(tx, ctx, id),
      nextHearing: nextId ? await getHearing(tx, ctx, nextId) : null,
      taskIds,
    };
  });
}

export async function cancelHearing(
  deps: Deps,
  ctx: TenantContext,
  id: string,
  reason: string,
  meta: RequestMeta,
): Promise<HearingDto> {
  return withTransaction(deps.pool, async (tx) => {
    const h = await lockHearing(tx, ctx, id);
    if (h.status !== 'scheduled') throw conflict('Only a scheduled hearing can be cancelled');
    await query(
      tx,
      sql`UPDATE hearings SET status = 'cancelled', cancelled_at = now(), cancelled_by = ${ctx.userId}, cancel_reason = ${reason}
          WHERE id = ${id}`,
    );
    await addTimelineEvent(tx, {
      organizationId: ctx.organizationId,
      matterId: h.matter_id,
      caseId: h.case_id,
      eventType: 'hearing.cancelled',
      title: `Hearing on ${when(h.scheduled_date, h.start_time)} cancelled`,
      description: `${h.case_label} · ${reason}`,
      actorUserId: ctx.userId,
      sourceType: 'hearing',
      sourceId: id,
    });
    await emitEvent(tx, {
      organizationId: ctx.organizationId,
      eventType: 'HEARING_CANCELLED',
      aggregateType: 'hearing',
      aggregateId: id,
      payload: { hearingId: id, caseId: h.case_id, matterId: h.matter_id, reason },
      actorUserId: ctx.userId,
    });
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'hearing.cancelled',
      entityType: 'hearing',
      entityId: id,
      before: { status: h.status },
      after: { status: 'cancelled', reason },
      meta,
    });
    await syncCaseNextHearing(tx, h.case_id);
    return getHearing(tx, ctx, id);
  });
}
