import type { NotifyRecipient, WorkflowAction, WorkflowCondition, WorkflowTiming, WorkflowTrigger } from '@legalops/types';
import { query, queryOne, withTransaction, type Db } from '../../db/pool.js';
import { sql } from '../../db/sql.js';
import type { Deps } from '../../deps.js';
import type { TenantContext } from '../../http/context.js';
import { buildContext, flatten, type ContextRefs, type TemplateContext } from '../notifications/context.js';
import { createNotification, type Recipient } from '../notifications/notifications.service.js';
import { createTaskInTx } from '../tasks/tasks.service.js';
import { addTimelineEvent } from '../timeline/timeline.service.js';

export type WorkflowRow = {
  id: string;
  organization_id: string;
  name: string;
  trigger_type: WorkflowTrigger;
  trigger_config: WorkflowTiming;
  conditions: WorkflowCondition[];
  actions: WorkflowAction[];
  requires_approval: boolean;
  is_active: boolean;
  created_by: string | null;
};

export type OutboxEvent = { id: string; organization_id: string; event_type: string; aggregate_type: string; aggregate_id: string; payload: Record<string, unknown> };

/** Target record for each trigger: what scheduled actions hang off and get re-checked/cancelled against. */
export function targetOf(event: Pick<OutboxEvent, 'event_type' | 'payload' | 'aggregate_id'>): { type: string; id: string; refs: ContextRefs } | null {
  const p = event.payload as Record<string, string | undefined>;
  switch (event.event_type) {
    case 'HEARING_SCHEDULED':
    case 'HEARING_CHANGED':
    case 'HEARING_COMPLETED':
    case 'HEARING_CANCELLED':
      return { type: 'hearing', id: p.hearingId ?? event.aggregate_id, refs: { hearingId: p.hearingId ?? event.aggregate_id } };
    case 'INVOICE_CREATED':
    case 'INVOICE_PAID':
    case 'INVOICE_VOIDED':
      return { type: 'invoice', id: p.invoiceId ?? event.aggregate_id, refs: { invoiceId: p.invoiceId ?? event.aggregate_id } };
    case 'PAYMENT_RECEIVED':
      return { type: 'payment', id: p.paymentId ?? event.aggregate_id, refs: { paymentId: p.paymentId ?? event.aggregate_id } };
    case 'TASK_CREATED':
    case 'TASK_COMPLETED':
      return { type: 'task', id: p.taskId ?? event.aggregate_id, refs: { taskId: p.taskId ?? event.aggregate_id } };
    case 'MATTER_CREATED':
      return { type: 'matter', id: p.matterId ?? event.aggregate_id, refs: { matterId: p.matterId ?? event.aggregate_id } };
    case 'CASE_CREATED':
    case 'CASE_STATUS_CHANGED':
      return { type: 'case', id: p.caseId ?? event.aggregate_id, refs: { caseId: p.caseId ?? event.aggregate_id } };
    default:
      return null;
  }
}

/** PRD §9.3 operators over the flattened context. Numeric comparison when both sides are numbers. */
export function evaluateCondition(c: WorkflowCondition, flat: Record<string, unknown>): { passed: boolean; actual: unknown } {
  const actual = flat[c.field];
  const empty = actual === undefined || actual === null || actual === '';
  const asNum = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : NaN);
  const eq = (a: unknown, b: unknown) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
  switch (c.operator) {
    case 'is_empty':
      return { passed: empty, actual };
    case 'is_not_empty':
      return { passed: !empty, actual };
    case 'equals':
      return { passed: eq(actual, c.value), actual };
    case 'not_equals':
      return { passed: !eq(actual, c.value), actual };
    case 'contains':
      return { passed: String(actual ?? '').toLowerCase().includes(String(c.value ?? '').toLowerCase()), actual };
    case 'greater_than': {
      const [a, b] = [asNum(actual), asNum(c.value)];
      return { passed: !Number.isNaN(a) && !Number.isNaN(b) && a > b, actual };
    }
    case 'less_than': {
      const [a, b] = [asNum(actual), asNum(c.value)];
      return { passed: !Number.isNaN(a) && !Number.isNaN(b) && a < b, actual };
    }
  }
}

export const conditionsPass = (conditions: WorkflowCondition[], flat: Record<string, unknown>) => conditions.every((c) => evaluateCondition(c, flat).passed);

/** The anchor's calendar date (firm-local) for relative timing. */
export function anchorDate(timing: WorkflowTiming, context: TemplateContext): string | null {
  if (timing.timing !== 'relative') return null;
  switch (timing.anchor) {
    case 'hearing.date':
      return context.raw.hearing?.scheduled_date ?? null;
    case 'invoice.due_date':
      return context.raw.invoice?.due_date ?? null;
    case 'task.due_date':
      return context.raw.task?.due_date ?? null;
  }
}

/** anchor date + offset days at HH:MM in the firm's timezone, as an instant. */
export async function computeRunAt(db: Db, organizationId: string, timing: WorkflowTiming, anchor: string | null, now: Date): Promise<Date | null> {
  if (timing.timing === 'immediate') return now;
  if (!anchor) return null;
  const r = await queryOne<{ t: Date }>(
    db,
    sql`SELECT ((${anchor}::date + ${timing.offsetDays}::int) + ${timing.at}::time) AT TIME ZONE (SELECT timezone FROM organizations WHERE id = ${organizationId}) AS t`,
  );
  return r!.t;
}

/** Reminders whose time already passed when planned aren't sent late (e.g. "7 days before" a hearing set 2 days out). */
const STALE_GRACE_MS = 60 * 60_000;

async function cancelPending(db: Db, organizationId: string, targetType: string, targetId: string, reason: string, triggerTypes?: WorkflowTrigger[]) {
  await query(
    db,
    sql`UPDATE scheduled_actions sa SET status = 'cancelled', cancelled_at = now(), cancel_reason = ${reason}
        WHERE sa.organization_id = ${organizationId} AND sa.target_type = ${targetType} AND sa.target_id = ${targetId} AND sa.status = 'scheduled'
          ${triggerTypes ? sql`AND sa.workflow_id IN (SELECT id FROM workflows WHERE trigger_type = ANY(${triggerTypes}::text[]))` : sql.empty}`,
  );
}

/**
 * Plans every active workflow for an event (PRD §9/§10). Writes scheduled_actions only; nothing is
 * sent here. Safe to replay: idempotency keys include workflow, action, target and anchor date.
 */
export async function planForEvent(deps: Deps, db: Db, event: OutboxEvent, now: Date, onlyWorkflowIds?: string[]): Promise<number> {
  const target = targetOf(event);
  if (!target) return 0;
  const org = event.organization_id;

  // Changes that invalidate earlier plans.
  if (event.event_type === 'HEARING_CHANGED') await cancelPending(db, org, 'hearing', target.id, 'Hearing rescheduled', ['HEARING_SCHEDULED']);
  if (event.event_type === 'HEARING_CANCELLED' || event.event_type === 'HEARING_COMPLETED') await cancelPending(db, org, 'hearing', target.id, `Hearing ${event.event_type === 'HEARING_CANCELLED' ? 'cancelled' : 'completed'}`, ['HEARING_SCHEDULED']);
  if (event.event_type === 'INVOICE_PAID' || event.event_type === 'INVOICE_VOIDED') await cancelPending(db, org, 'invoice', target.id, event.event_type === 'INVOICE_PAID' ? 'Invoice paid' : 'Invoice voided', ['INVOICE_CREATED']);
  if (event.event_type === 'TASK_COMPLETED') await cancelPending(db, org, 'task', target.id, 'Task completed', ['TASK_CREATED']);

  // A rescheduled hearing re-plans the "hearing scheduled" workflows against the new date.
  const trigger = (event.event_type === 'HEARING_CHANGED' ? 'HEARING_SCHEDULED' : event.event_type) as WorkflowTrigger;
  const workflows = (
    await query<WorkflowRow>(
      db,
      sql`SELECT * FROM workflows WHERE organization_id = ${org} AND trigger_type = ${trigger} AND is_active ORDER BY created_at`,
    )
  ).filter((wf) => !onlyWorkflowIds || onlyWorkflowIds.includes(wf.id));
  if (workflows.length === 0) return 0;

  const context = await buildContext(db, org, { ...target.refs, ...refsFromPayload(event.payload) }, now, deps.env.APP_URL);
  const flat = { ...flatten(context.vars), ...payloadFacts(event) };
  let planned = 0;
  for (const wf of workflows) {
    if (!conditionsPass(wf.conditions, flat)) continue;
    const anchor = anchorDate(wf.trigger_config, context);
    const runAt = await computeRunAt(db, org, wf.trigger_config, anchor, now);
    if (!runAt) continue;
    if (wf.trigger_config.timing === 'relative' && runAt.getTime() < now.getTime() - STALE_GRACE_MS) continue;
    for (const [i, action] of wf.actions.entries()) {
      const rows = await query(
        db,
        sql`INSERT INTO scheduled_actions (organization_id, workflow_id, action_index, action_type, target_type, target_id, source_event_id,
                                           idempotency_key, run_at, payload)
            VALUES (${org}, ${wf.id}, ${i}, ${action.type}, ${target.type}, ${target.id}, ${event.id},
                    ${`${wf.id}:${i}:${target.type}:${target.id}:${anchor ?? event.id}`}, ${runAt.toISOString()},
                    ${JSON.stringify({ action, anchor, refs: { ...target.refs, ...refsFromPayload(event.payload) }, eventType: event.event_type })})
            ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      );
      planned += rows.length;
    }
  }
  return planned;
}

/**
 * Hearing recipes a firm receives after its hearings were planned (new defaults, D-013) also cover
 * the hearings already on its calendar. Only the given recipes are planned; idempotency keys make
 * this safe to repeat.
 */
export async function planUpcomingHearings(deps: Deps, db: Db, source: OutboxEvent, now: Date, systemKeys: string[]): Promise<number> {
  const org = source.organization_id;
  const ids = (
    await query<{ id: string }>(
      db,
      sql`SELECT id FROM workflows WHERE organization_id = ${org} AND system_key = ANY(${systemKeys}) AND trigger_type = 'HEARING_SCHEDULED'`,
    )
  ).map((w) => w.id);
  if (!ids.length) return 0;
  const hearings = await query<{ id: string; case_id: string; matter_id: string }>(
    db,
    sql`SELECT h.id, h.case_id, c.matter_id FROM hearings h
        JOIN cases c ON c.id = h.case_id JOIN organizations o ON o.id = h.organization_id
        WHERE h.organization_id = ${org} AND h.status = 'scheduled'
          AND h.scheduled_date >= ((${now.toISOString()}::timestamptz AT TIME ZONE o.timezone)::date)`,
  );
  let planned = 0;
  for (const h of hearings) {
    planned += await planForEvent(
      deps,
      db,
      { ...source, event_type: 'HEARING_SCHEDULED', aggregate_type: 'hearing', aggregate_id: h.id, payload: { hearingId: h.id, caseId: h.case_id, matterId: h.matter_id } },
      now,
      ids,
    );
  }
  return planned;
}

function refsFromPayload(p: Record<string, unknown>): ContextRefs {
  const s = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : undefined);
  return Object.fromEntries(
    Object.entries({ matterId: s('matterId'), caseId: s('caseId'), clientId: s('clientId') }).filter(([, v]) => v !== undefined),
  ) as ContextRefs;
}

/** Event facts not stored on records (e.g. the result of a hearing). */
function payloadFacts(event: Pick<OutboxEvent, 'event_type' | 'payload'>): Record<string, unknown> {
  const p = event.payload as Record<string, unknown>;
  if (event.event_type === 'HEARING_COMPLETED') return { 'hearing.result': p.result, 'hearing.next_date': p.nextHearingDate ?? '' };
  return {};
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** Claims due actions for execution. The worker enqueues the ids; tests/dev run them inline. */
export async function claimDueActions(db: Db, now: Date, limit = 50): Promise<string[]> {
  const rows = await query<{ id: string }>(
    db,
    sql`UPDATE scheduled_actions SET status = 'queued'
        WHERE id IN (SELECT id FROM scheduled_actions WHERE status = 'scheduled' AND run_at <= ${now.toISOString()}
                     ORDER BY run_at LIMIT ${limit} FOR UPDATE SKIP LOCKED)
        RETURNING id`,
  );
  return rows.map((r) => r.id);
}

/** Actions left queued/running by a crashed worker go back to scheduled (execution is idempotent). */
export async function requeueStuckActions(db: Db, olderThanMinutes = 10): Promise<number> {
  const rows = await query(
    db,
    sql`UPDATE scheduled_actions SET status = 'scheduled' WHERE status IN ('queued', 'running') AND updated_at < now() - ${`${olderThanMinutes} minutes`}::interval RETURNING id`,
  );
  return rows.length;
}

type ActionPayload = { action: WorkflowAction; anchor: string | null; refs: ContextRefs; eventType: string };

/** Is the target still in the state this action was planned for? Stale reminders are skipped, not sent. */
function stillValid(sa: { target_type: string }, payload: ActionPayload, context: TemplateContext): string | null {
  const relative = payload.anchor !== null;
  if (sa.target_type === 'hearing' && payload.eventType !== 'HEARING_COMPLETED' && payload.eventType !== 'HEARING_CANCELLED') {
    const h = context.raw.hearing;
    if (!h || h.status !== 'scheduled') return 'Hearing is no longer scheduled';
    if (relative && h.scheduled_date !== payload.anchor) return 'Hearing date changed';
  }
  if (sa.target_type === 'invoice' && payload.eventType === 'INVOICE_CREATED') {
    const i = context.raw.invoice;
    if (!i || i.status !== 'issued') return 'Invoice is no longer open';
    if (relative) {
      if (Number(i.amount_due) <= 0) return 'Invoice already paid';
      if (i.due_date !== payload.anchor) return 'Due date changed';
    }
  }
  if (sa.target_type === 'task' && payload.eventType === 'TASK_CREATED' && relative) {
    const t = context.raw.task;
    if (!t || !['todo', 'in_progress', 'blocked'].includes(t.status)) return 'Task is closed';
    if (t.due_date !== payload.anchor) return 'Task due date changed';
  }
  return null;
}

async function resolveRecipients(db: Db, organizationId: string, who: NotifyRecipient, context: TemplateContext): Promise<{ key: string; recipient: Recipient; skip?: string }[]> {
  const users = (rows: { user_id: string }[]) => rows.map((r) => ({ key: `user:${r.user_id}`, recipient: { type: 'user', userId: r.user_id } as Recipient }));
  switch (who) {
    case 'client':
      return context.refs.clientId ? [{ key: `client:${context.refs.clientId}`, recipient: { type: 'client', clientId: context.refs.clientId } }] : [];
    case 'lead':
      return context.raw.leadUserId ? users([{ user_id: context.raw.leadUserId }]) : [];
    case 'matter_team':
      return context.refs.matterId ? users(await query(db, sql`SELECT user_id FROM matter_staff WHERE matter_id = ${context.refs.matterId}`)) : [];
    case 'assignee': {
      const t = context.raw.task;
      if (!t?.assignee_id) return [];
      // Assigning a task to yourself doesn't email you about it.
      if (t.assignee_id === t.created_by) return [];
      return users([{ user_id: t.assignee_id }]);
    }
    case 'owners':
      return users(await query(db, sql`SELECT user_id FROM organization_members WHERE organization_id = ${organizationId} AND role = 'owner' AND status = 'active'`));
    case 'finance':
      return users(await query(db, sql`SELECT user_id FROM organization_members WHERE organization_id = ${organizationId} AND role = 'finance' AND status = 'active'`));
  }
}

/**
 * Executes one scheduled action, re-checking target state and conditions at run time. Idempotent:
 * notifications and tasks carry keys derived from the action id, so a re-run creates nothing new.
 */
export async function executeScheduledAction(deps: Deps, id: string, now: Date): Promise<'done' | 'skipped' | 'cancelled' | 'not_ready'> {
  return withTransaction(deps.pool, async (tx) => {
    const sa = await queryOne<{ id: string; organization_id: string; workflow_id: string; target_type: string; target_id: string; status: string; payload: ActionPayload; source_event_id: string | null }>(
      tx,
      sql`UPDATE scheduled_actions SET status = 'running', attempts = attempts + 1
          WHERE id = ${id} AND status IN ('queued', 'scheduled') AND run_at <= ${now.toISOString()}
          RETURNING id, organization_id, workflow_id, target_type, target_id, status, payload, source_event_id`,
    );
    if (!sa) return 'not_ready';
    const finish = async (status: 'done' | 'skipped' | 'cancelled', result: Record<string, unknown>) => {
      await query(tx, sql`UPDATE scheduled_actions SET status = ${status}, executed_at = now(), result = ${JSON.stringify(result)} WHERE id = ${id}`);
      return status;
    };
    const wf = await queryOne<WorkflowRow>(tx, sql`SELECT * FROM workflows WHERE id = ${sa.workflow_id}`);
    if (!wf || !wf.is_active) return finish('cancelled', { reason: 'Automation switched off' });
    // Firm-wide reminders switch (Firm settings). A reminder is an email sent on a schedule relative to a date;
    // ones that fall due while it is off are skipped, never held back, and later ones resume once it is on again.
    if (wf.trigger_config.timing === 'relative' && sa.payload.action.type === 'notify') {
      const org = await queryOne<{ reminders_enabled: boolean }>(tx, sql`SELECT reminders_enabled FROM organizations WHERE id = ${sa.organization_id}`);
      if (org && !org.reminders_enabled) return finish('skipped', { reason: 'Reminders are switched off for this firm' });
    }

    const context = await buildContext(tx, sa.organization_id, sa.payload.refs, now, deps.env.APP_URL);
    // Suspended firms send nothing; due actions are recorded as skipped, never deferred (L-12).
    if (context.raw.orgStatus === 'suspended') return finish('skipped', { reason: 'Firm suspended' });
    const invalid = stillValid(sa, sa.payload, context);
    if (invalid) return finish('skipped', { reason: invalid });
    const flat = { ...flatten(context.vars), ...payloadFacts({ event_type: sa.payload.eventType, payload: (await sourcePayload(tx, sa.source_event_id)) ?? {} }) };
    if (!conditionsPass(wf.conditions, flat)) return finish('skipped', { reason: 'Conditions no longer met' });

    const action = sa.payload.action;
    const actor = await systemActor(tx, sa.organization_id, wf.created_by);
    switch (action.type) {
      case 'notify': {
        const recipients = await resolveRecipients(tx, sa.organization_id, action.recipient, context);
        const created: string[] = [];
        for (const r of recipients) {
          const n = await createNotification(tx, deps.env.APP_URL, {
            organizationId: sa.organization_id,
            templateKey: action.templateKey,
            recipient: r.recipient,
            refs: sa.payload.refs,
            now,
            requiresApproval: wf.requires_approval,
            workflowId: wf.id,
            scheduledActionId: sa.id,
            sourceEventId: sa.source_event_id,
            idempotencyKey: `${sa.id}:${r.key}`,
          });
          created.push(n.id);
        }
        return finish('done', { notifications: created, recipients: recipients.length });
      }
      case 'create_task': {
        const assignee =
          action.assignTo === 'lead'
            ? context.raw.leadUserId
            : action.assignTo === 'assignee'
              ? context.raw.task?.assignee_id ?? null
              : (await queryOne<{ user_id: string }>(tx, sql`SELECT user_id FROM organization_members WHERE organization_id = ${sa.organization_id} AND role = 'owner' AND status = 'active' ORDER BY joined_at LIMIT 1`))?.user_id ?? null;
        const due = action.dueInDays != null ? (await queryOne<{ d: string }>(tx, sql`SELECT (${context.raw.today}::date + ${action.dueInDays}::int)::text AS d`))!.d : null;
        const taskId = await createTaskInTx(
          tx,
          actor,
          { title: action.title, priority: action.priority ?? 'normal', assigneeId: assignee, dueDate: due, matterId: context.refs.matterId, caseId: context.refs.caseId, hearingId: context.refs.hearingId },
          { requestId: `workflow:${sa.id}`, ip: null, userAgent: 'workflow' },
          { sourceEventId: sa.source_event_id, idempotencyKey: `wf:${sa.id}`, actorType: 'workflow' },
        );
        return finish('done', { taskId });
      }
      case 'update_task': {
        if (!context.refs.taskId) return finish('skipped', { reason: 'No task' });
        await query(
          tx,
          sql`UPDATE tasks SET priority = COALESCE(${action.priority ?? null}, priority), status = COALESCE(${action.status ?? null}, status)
              WHERE id = ${context.refs.taskId} AND status IN ('todo', 'in_progress', 'blocked')`,
        );
        return finish('done', { taskId: context.refs.taskId });
      }
      case 'add_timeline': {
        if (!context.refs.matterId) return finish('skipped', { reason: 'No matter' });
        await addTimelineEvent(tx, { organizationId: sa.organization_id, matterId: context.refs.matterId, caseId: context.refs.caseId, eventType: 'workflow.note', title: action.title, description: wf.name, actorUserId: null, actorType: 'workflow', sourceType: 'workflow', sourceId: wf.id });
        return finish('done', {});
      }
      case 'add_tag': {
        if (!context.refs.matterId) return finish('skipped', { reason: 'No matter' });
        await query(tx, sql`UPDATE matters SET tags = array_append(tags, ${action.tag}) WHERE id = ${context.refs.matterId} AND NOT (${action.tag} = ANY(tags))`);
        return finish('done', { tag: action.tag });
      }
    }
  });
}

async function sourcePayload(db: Db, eventId: string | null): Promise<Record<string, unknown> | null> {
  if (!eventId) return null;
  return (await queryOne<{ payload: Record<string, unknown> }>(db, sql`SELECT payload FROM outbox_events WHERE id = ${eventId}`))?.payload ?? null;
}

/** Actions run as the workflow's author (or the first owner), with firm-wide visibility. */
async function systemActor(db: Db, organizationId: string, createdBy: string | null): Promise<TenantContext> {
  const userId =
    createdBy ??
    (await queryOne<{ user_id: string }>(db, sql`SELECT user_id FROM organization_members WHERE organization_id = ${organizationId} AND role = 'owner' ORDER BY joined_at LIMIT 1`))!.user_id;
  return { organizationId, userId, role: 'owner' };
}
