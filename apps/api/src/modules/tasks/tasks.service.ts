import {
  can,
  seesAllMatters,
  TASK_STATUS_LABELS,
  type TaskCommentDto,
  type TaskDto,
  type TaskStatus,
} from '@legalops/types';
import type { createTaskSchema, listTasksSchema, updateTaskSchema } from '@legalops/validation';
import type { z } from 'zod';
import { query, queryOne, withTransaction, type Db } from '../../db/pool.js';
import { sql, type SqlFragment } from '../../db/sql.js';
import type { Deps } from '../../deps.js';
import type { RequestMeta, TenantContext } from '../../http/context.js';
import { displayDate } from '../../http/dates.js';
import { conflict, forbidden, notFound, validationError } from '../../http/errors.js';
import { assertActiveMembers, iso, pageClause } from '../../http/query-helpers.js';
import { assertMatterVisible, matterVisible } from '../access/matter-scope.js';
import { recordAudit } from '../audit/audit.service.js';
import { emitEvent } from '../outbox/outbox.service.js';
import { addTimelineEvent } from '../timeline/timeline.service.js';

const OPEN = sql`t.status IN ('todo', 'in_progress', 'blocked')`;

/**
 * Task visibility (decisions.md D-004): firm-wide roles see all; others see tasks on matters they're
 * assigned to, plus any task assigned to them or created by them (even without matter access).
 */
export function taskVisible(ctx: TenantContext): SqlFragment {
  if (seesAllMatters(ctx.role)) return sql`TRUE`;
  return sql`(t.assignee_id = ${ctx.userId} OR t.created_by = ${ctx.userId}
             OR (t.matter_id IS NOT NULL AND ${matterVisible(ctx, sql.raw('t.matter_id'))}))`;
}

type TaskRow = {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskDto['priority'];
  due_at: Date | null;
  due_date: string | null;
  overdue: boolean;
  assignee_id: string | null;
  a_first: string | null;
  a_last: string | null;
  created_by: string | null;
  c_first: string | null;
  c_last: string | null;
  completed_by: string | null;
  d_first: string | null;
  d_last: string | null;
  completed_at: Date | null;
  matter_id: string | null;
  matter_title: string | null;
  case_id: string | null;
  hearing_id: string | null;
  source_event_id: string | null;
  created_at: Date;
};

const TASK_SELECT = sql`
  t.id, t.title, t.description, t.status, t.priority, t.due_at,
  (t.due_at AT TIME ZONE o.timezone)::date::text AS due_date,
  (${OPEN} AND t.due_at < now()) AS overdue,
  t.assignee_id, au.first_name AS a_first, au.last_name AS a_last,
  t.created_by, cu.first_name AS c_first, cu.last_name AS c_last,
  t.completed_by, du.first_name AS d_first, du.last_name AS d_last, t.completed_at,
  t.matter_id, m.title AS matter_title, t.case_id, t.hearing_id, t.source_event_id, t.created_at`;

const TASK_FROM = sql`
  tasks t
  JOIN organizations o ON o.id = t.organization_id
  LEFT JOIN matters m ON m.id = t.matter_id
  LEFT JOIN users au ON au.id = t.assignee_id
  LEFT JOIN users cu ON cu.id = t.created_by
  LEFT JOIN users du ON du.id = t.completed_by`;

const ref = (id: string | null, first: string | null, last: string | null) =>
  id ? { userId: id, firstName: first ?? '', lastName: last } : null;

const toDto = (r: TaskRow): TaskDto => ({
  id: r.id,
  title: r.title,
  description: r.description,
  status: r.status,
  priority: r.priority,
  dueAt: iso(r.due_at),
  dueDate: r.due_date,
  overdue: r.overdue,
  assignee: ref(r.assignee_id, r.a_first, r.a_last),
  createdBy: ref(r.created_by, r.c_first, r.c_last),
  completedBy: ref(r.completed_by, r.d_first, r.d_last),
  completedAt: iso(r.completed_at),
  matter: r.matter_id ? { id: r.matter_id, title: r.matter_title ?? '' } : null,
  caseId: r.case_id,
  hearingId: r.hearing_id,
  sourceEventId: r.source_event_id,
  createdAt: iso(r.created_at)!,
});

export async function queryTasks(
  db: Db,
  ctx: TenantContext,
  where: SqlFragment[],
  order: SqlFragment,
  page?: { page: number; pageSize: number },
): Promise<{ items: TaskDto[]; total: number }> {
  const rows = await query<TaskRow & { total: number }>(
    db,
    sql`SELECT ${TASK_SELECT}, count(*) OVER ()::int AS total FROM ${TASK_FROM}
        WHERE ${sql.join([sql`t.organization_id = ${ctx.organizationId}`, taskVisible(ctx), ...where], ' AND ')}
        ORDER BY ${order}
        ${page ? pageClause(page) : sql`LIMIT 200`}`,
  );
  return { items: rows.map(toDto), total: rows[0]?.total ?? 0 };
}

export async function listTasks(deps: Deps, ctx: TenantContext, f: z.output<typeof listTasksSchema>) {
  const where: SqlFragment[] = [];
  let order = sql`t.due_at ASC NULLS LAST, t.priority = 'urgent' DESC, t.created_at`;
  switch (f.view) {
    case 'mine':
      where.push(sql`t.assignee_id = ${ctx.userId}`, OPEN);
      break;
    case 'team':
      where.push(OPEN);
      break;
    case 'overdue':
      where.push(OPEN, sql`t.due_at < now()`);
      break;
    case 'completed':
      where.push(sql`t.status = 'done'`);
      order = sql`t.completed_at DESC`;
      break;
    case 'all':
      break;
  }
  if (f.matterId) where.push(sql`t.matter_id = ${f.matterId}`);
  if (f.hearingId) where.push(sql`t.hearing_id = ${f.hearingId}`);
  if (f.assigneeId) where.push(sql`t.assignee_id = ${f.assigneeId}`);
  return queryTasks(deps.pool, ctx, where, order, f);
}

export async function getTask(db: Db, ctx: TenantContext, id: string): Promise<TaskDto> {
  const { items } = await queryTasks(db, ctx, [sql`t.id = ${id}`], sql`t.id`);
  if (!items[0]) throw notFound('Task');
  return items[0];
}

/** Due date + optional time in the firm's timezone -> instant. No time = end of that day. */
const dueAtSql = (
  organizationId: string,
  dueDate: string | null | undefined,
  dueTime: string | null | undefined,
) =>
  dueDate
    ? sql`((${dueDate}::date + ${dueTime ?? '23:59'}::time) AT TIME ZONE (SELECT timezone FROM organizations WHERE id = ${organizationId}))`
    : sql`NULL`;

type TaskCreate = {
  title: string;
  description?: string | null | undefined;
  priority: TaskDto['priority'];
  dueDate?: string | null | undefined;
  dueTime?: string | null | undefined;
  assigneeId?: string | null | undefined;
  matterId?: string | null | undefined;
  caseId?: string | null | undefined;
  hearingId?: string | null | undefined;
};

/**
 * Creates a task inside the caller's transaction. Links are normalised (hearing -> case -> matter) and
 * checked for visibility. `idempotencyKey` makes workflow-created tasks safe to replay.
 */
export async function createTaskInTx(
  db: Db,
  ctx: TenantContext,
  input: TaskCreate,
  meta: RequestMeta,
  opts: { sourceEventId?: string | null; idempotencyKey?: string; actorType?: 'user' | 'workflow' } = {},
): Promise<string> {
  let { matterId = null, caseId = null } = input;
  const hearingId = input.hearingId ?? null;
  if (hearingId) {
    const h = await queryOne<{ case_id: string; matter_id: string }>(
      db,
      sql`SELECT h.case_id, cs.matter_id FROM hearings h JOIN cases cs ON cs.id = h.case_id
          WHERE h.id = ${hearingId} AND h.organization_id = ${ctx.organizationId}`,
    );
    if (!h) throw notFound('Hearing');
    if ((caseId && caseId !== h.case_id) || (matterId && matterId !== h.matter_id)) {
      throw validationError('The hearing belongs to a different case', [
        { path: 'hearingId', message: 'Mismatched links' },
      ]);
    }
    caseId = h.case_id;
    matterId = h.matter_id;
  } else if (caseId) {
    const c = await queryOne<{ matter_id: string }>(
      db,
      sql`SELECT matter_id FROM cases WHERE id = ${caseId} AND organization_id = ${ctx.organizationId}`,
    );
    if (!c) throw notFound('Case');
    if (matterId && matterId !== c.matter_id) {
      throw validationError('The case belongs to a different matter', [
        { path: 'caseId', message: 'Mismatched links' },
      ]);
    }
    matterId = c.matter_id;
  }
  if (matterId) await assertMatterVisible(db, ctx, matterId);
  if (input.assigneeId) await assertActiveMembers(db, ctx.organizationId, [input.assigneeId], 'assigneeId');

  const row = await queryOne<{ id: string; inserted: boolean }>(
    db,
    sql`INSERT INTO tasks (organization_id, matter_id, case_id, hearing_id, title, description, assignee_id, created_by,
                           priority, due_at, source_event_id, idempotency_key)
        VALUES (${ctx.organizationId}, ${matterId}, ${caseId}, ${hearingId}, ${input.title}, ${input.description ?? null},
                ${input.assigneeId ?? null}, ${ctx.userId}, ${input.priority},
                ${dueAtSql(ctx.organizationId, input.dueDate, input.dueTime)},
                ${opts.sourceEventId ?? null}, ${opts.idempotencyKey ?? null})
        ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
        RETURNING id, (xmax = 0) AS inserted`,
  );
  const id = row!.id;
  if (!row!.inserted) return id; // replayed workflow action: already done

  const assignee = input.assigneeId
    ? await queryOne<{ first_name: string; last_name: string | null }>(
        db,
        sql`SELECT first_name, last_name FROM users WHERE id = ${input.assigneeId}`,
      )
    : null;
  if (matterId) {
    await addTimelineEvent(db, {
      organizationId: ctx.organizationId,
      matterId,
      caseId,
      eventType: 'task.created',
      title: `Task: ${input.title}`,
      description:
        [
          assignee ? `For ${`${assignee.first_name} ${assignee.last_name ?? ''}`.trim()}` : 'Unassigned',
          input.dueDate ? `due ${displayDate(input.dueDate)}` : null,
        ]
          .filter(Boolean)
          .join(' · ') || null,
      actorUserId: opts.actorType === 'workflow' ? null : ctx.userId,
      actorType: opts.actorType ?? 'user',
      sourceType: 'task',
      sourceId: id,
    });
  }
  await emitEvent(db, {
    organizationId: ctx.organizationId,
    eventType: 'TASK_CREATED',
    aggregateType: 'task',
    aggregateId: id,
    payload: { taskId: id, matterId, assigneeId: input.assigneeId ?? null, dueDate: input.dueDate ?? null },
    actorUserId: ctx.userId,
  });
  await recordAudit(db, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'task.created',
    entityType: 'task',
    entityId: id,
    after: { ...input, matterId, caseId, hearingId },
    meta,
  });
  return id;
}

export async function createTask(
  deps: Deps,
  ctx: TenantContext,
  input: z.output<typeof createTaskSchema>,
  meta: RequestMeta,
): Promise<TaskDto> {
  return withTransaction(deps.pool, async (tx) => {
    const id = await createTaskInTx(tx, ctx, input, meta);
    return getTask(tx, ctx, id);
  });
}

/** Loads + locks a visible task. Changing it needs tasks.manage, or being its assignee. */
async function lockTask(db: Db, ctx: TenantContext, id: string, action: 'change' | 'reassign') {
  const row = await queryOne<{
    id: string;
    status: TaskStatus;
    assignee_id: string | null;
    matter_id: string | null;
    title: string;
  }>(
    db,
    sql`SELECT t.id, t.status, t.assignee_id, t.matter_id, t.title FROM tasks t
        WHERE t.id = ${id} AND t.organization_id = ${ctx.organizationId} AND ${taskVisible(ctx)}
        FOR UPDATE OF t`,
  );
  if (!row) throw notFound('Task');
  const isAssignee = row.assignee_id === ctx.userId;
  if (!can(ctx.role, 'tasks.manage') && !(action === 'change' && isAssignee)) throw forbidden();
  return row;
}

const TASK_COLUMNS = {
  title: 'title',
  description: 'description',
  priority: 'priority',
  status: 'status',
} as const;

export async function updateTask(
  deps: Deps,
  ctx: TenantContext,
  id: string,
  input: z.output<typeof updateTaskSchema>,
  meta: RequestMeta,
): Promise<TaskDto> {
  return withTransaction(deps.pool, async (tx) => {
    const before = await lockTask(tx, ctx, id, 'change');
    if (before.status === 'done') throw conflict('Completed tasks can’t be edited');
    const sets = (Object.keys(TASK_COLUMNS) as (keyof typeof TASK_COLUMNS)[])
      .filter((k) => input[k] !== undefined)
      .map((k) => sql`${sql.raw(TASK_COLUMNS[k])} = ${input[k]}`);
    if (input.dueDate !== undefined)
      sets.push(sql`due_at = ${dueAtSql(ctx.organizationId, input.dueDate, input.dueTime)}`);
    if (sets.length > 0) await query(tx, sql`UPDATE tasks SET ${sql.join(sets)} WHERE id = ${id}`);
    if (input.status && input.status !== before.status && before.matter_id) {
      await addTimelineEvent(tx, {
        organizationId: ctx.organizationId,
        matterId: before.matter_id,
        eventType: 'task.status_changed',
        title: `Task ${TASK_STATUS_LABELS[input.status].toLowerCase()}: ${before.title}`,
        actorUserId: ctx.userId,
        sourceType: 'task',
        sourceId: id,
      });
    }
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'task.updated',
      entityType: 'task',
      entityId: id,
      before,
      after: input,
      meta,
    });
    return getTask(tx, ctx, id);
  });
}

export async function completeTask(
  deps: Deps,
  ctx: TenantContext,
  id: string,
  meta: RequestMeta,
): Promise<TaskDto> {
  return withTransaction(deps.pool, async (tx) => {
    const t = await lockTask(tx, ctx, id, 'change');
    if (t.status === 'done') throw conflict('This task is already complete');
    if (t.status === 'cancelled') throw conflict('This task was cancelled');
    await query(
      tx,
      sql`UPDATE tasks SET status = 'done', completed_at = now(), completed_by = ${ctx.userId} WHERE id = ${id}`,
    );
    if (t.matter_id) {
      await addTimelineEvent(tx, {
        organizationId: ctx.organizationId,
        matterId: t.matter_id,
        eventType: 'task.completed',
        title: `Task done: ${t.title}`,
        actorUserId: ctx.userId,
        sourceType: 'task',
        sourceId: id,
      });
    }
    await emitEvent(tx, {
      organizationId: ctx.organizationId,
      eventType: 'TASK_COMPLETED',
      aggregateType: 'task',
      aggregateId: id,
      payload: { taskId: id, matterId: t.matter_id },
      actorUserId: ctx.userId,
    });
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'task.completed',
      entityType: 'task',
      entityId: id,
      before: { status: t.status },
      after: { status: 'done' },
      meta,
    });
    return getTask(tx, ctx, id);
  });
}

export async function reassignTask(
  deps: Deps,
  ctx: TenantContext,
  id: string,
  assigneeId: string | null,
  meta: RequestMeta,
): Promise<TaskDto> {
  return withTransaction(deps.pool, async (tx) => {
    const t = await lockTask(tx, ctx, id, 'reassign');
    if (t.status === 'done' || t.status === 'cancelled') throw conflict('Closed tasks can’t be reassigned');
    if (assigneeId) await assertActiveMembers(tx, ctx.organizationId, [assigneeId], 'assigneeId');
    await query(tx, sql`UPDATE tasks SET assignee_id = ${assigneeId} WHERE id = ${id}`);
    const who = assigneeId
      ? await queryOne<{ first_name: string; last_name: string | null }>(
          tx,
          sql`SELECT first_name, last_name FROM users WHERE id = ${assigneeId}`,
        )
      : null;
    if (t.matter_id) {
      await addTimelineEvent(tx, {
        organizationId: ctx.organizationId,
        matterId: t.matter_id,
        eventType: 'task.reassigned',
        title: `Task reassigned: ${t.title}`,
        description: who ? `Now with ${`${who.first_name} ${who.last_name ?? ''}`.trim()}` : 'Unassigned',
        actorUserId: ctx.userId,
        sourceType: 'task',
        sourceId: id,
      });
    }
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'task.reassigned',
      entityType: 'task',
      entityId: id,
      before: { assigneeId: t.assignee_id },
      after: { assigneeId },
      meta,
    });
    return getTask(tx, ctx, id);
  });
}

export async function listComments(
  deps: Deps,
  ctx: TenantContext,
  taskId: string,
): Promise<TaskCommentDto[]> {
  await getTask(deps.pool, ctx, taskId);
  const rows = await query<{
    id: string;
    body: string;
    author_id: string | null;
    first_name: string | null;
    last_name: string | null;
    created_at: Date;
  }>(
    deps.pool,
    sql`SELECT c.id, c.body, c.author_id, u.first_name, u.last_name, c.created_at
        FROM task_comments c LEFT JOIN users u ON u.id = c.author_id
        WHERE c.organization_id = ${ctx.organizationId} AND c.task_id = ${taskId}
        ORDER BY c.created_at`,
  );
  return rows.map((r) => ({
    id: r.id,
    body: r.body,
    author: ref(r.author_id, r.first_name, r.last_name),
    createdAt: iso(r.created_at)!,
  }));
}

export async function addComment(
  deps: Deps,
  ctx: TenantContext,
  taskId: string,
  body: string,
  meta: RequestMeta,
): Promise<TaskCommentDto[]> {
  if (ctx.role === 'read_only') throw forbidden();
  await withTransaction(deps.pool, async (tx) => {
    await getTask(tx, ctx, taskId);
    const row = await queryOne<{ id: string }>(
      tx,
      sql`INSERT INTO task_comments (organization_id, task_id, author_id, body) VALUES (${ctx.organizationId}, ${taskId}, ${ctx.userId}, ${body}) RETURNING id`,
    );
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'task.commented',
      entityType: 'task',
      entityId: taskId,
      after: { commentId: row!.id },
      meta,
    });
  });
  return listComments(deps, ctx, taskId);
}
