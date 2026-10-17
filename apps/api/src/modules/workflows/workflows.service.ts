import { ACTION_LABELS, RECIPIENT_LABELS, type WorkflowDryRunDto, type WorkflowDto } from '@legalops/types';
import type { workflowSchema } from '@legalops/validation';
import type { z } from 'zod';
import { query, queryOne, withTransaction, type Db } from '../../db/pool.js';
import { sql } from '../../db/sql.js';
import type { Deps } from '../../deps.js';
import type { RequestMeta, TenantContext } from '../../http/context.js';
import { notFound, validationError } from '../../http/errors.js';
import { iso } from '../../http/query-helpers.js';
import { recordAudit } from '../audit/audit.service.js';
import { buildContext, flatten } from '../notifications/context.js';
import { resolveTemplate } from '../templates/templates.service.js';
import { ensureDefaultsOnce } from './defaults.js';
import { anchorDate, computeRunAt, evaluateCondition, targetOf, type WorkflowRow } from './engine.js';

type Row = WorkflowRow & { description: string | null; system_key: string | null; updated_at: Date; scheduled: number; done: number; last_run_at: Date | null };

const toDto = (r: Row): WorkflowDto => ({
  id: r.id,
  name: r.name,
  description: r.description,
  systemKey: r.system_key,
  triggerType: r.trigger_type,
  triggerConfig: r.trigger_config,
  conditions: r.conditions,
  actions: r.actions,
  requiresApproval: r.requires_approval,
  isActive: r.is_active,
  updatedAt: iso(r.updated_at)!,
  stats: { scheduled: r.scheduled, done: r.done, lastRunAt: iso(r.last_run_at) },
});

const SELECT = sql`w.*,
  (SELECT count(*)::int FROM scheduled_actions sa WHERE sa.workflow_id = w.id AND sa.status = 'scheduled') AS scheduled,
  (SELECT count(*)::int FROM scheduled_actions sa WHERE sa.workflow_id = w.id AND sa.status = 'done') AS done,
  (SELECT max(sa.executed_at) FROM scheduled_actions sa WHERE sa.workflow_id = w.id AND sa.status = 'done') AS last_run_at`;

export async function listWorkflows(deps: Deps, ctx: TenantContext): Promise<WorkflowDto[]> {
  // Firms created before automations existed get the defaults on first visit too.
  await withTransaction(deps.pool, (tx) => ensureDefaultsOnce(tx, ctx.organizationId));
  const rows = await query<Row>(deps.pool, sql`SELECT ${SELECT} FROM workflows w WHERE w.organization_id = ${ctx.organizationId} AND w.trigger_type <> 'DELETED' ORDER BY w.trigger_type, w.created_at`);
  return rows.map(toDto);
}

export async function getWorkflow(db: Db, ctx: TenantContext, id: string): Promise<WorkflowDto> {
  const row = await queryOne<Row>(db, sql`SELECT ${SELECT} FROM workflows w WHERE w.id = ${id} AND w.organization_id = ${ctx.organizationId} AND w.trigger_type <> 'DELETED'`);
  if (!row) throw notFound('Automation');
  return toDto(row);
}

async function checkTemplates(db: Db, ctx: TenantContext, input: z.output<typeof workflowSchema>) {
  for (const [i, a] of input.actions.entries()) {
    if (a.type === 'notify' && !(await resolveTemplate(db, ctx.organizationId, a.templateKey))) {
      throw validationError('Unknown email template', [{ path: `actions.${i}.templateKey`, message: `No template "${a.templateKey}"` }]);
    }
  }
}

export async function createWorkflow(deps: Deps, ctx: TenantContext, input: z.output<typeof workflowSchema>, meta: RequestMeta) {
  return withTransaction(deps.pool, async (tx) => {
    await checkTemplates(tx, ctx, input);
    const row = await queryOne<{ id: string }>(
      tx,
      sql`INSERT INTO workflows (organization_id, name, description, trigger_type, trigger_config, conditions, actions, requires_approval, is_active, created_by)
          VALUES (${ctx.organizationId}, ${input.name}, ${input.description ?? null}, ${input.triggerType}, ${JSON.stringify(input.triggerConfig)},
                  ${JSON.stringify(input.conditions)}, ${JSON.stringify(input.actions)}, ${input.requiresApproval}, ${input.isActive}, ${ctx.userId})
          RETURNING id`,
    );
    await recordAudit(tx, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: 'workflow.created', entityType: 'workflow', entityId: row!.id, after: input, meta });
    return getWorkflow(tx, ctx, row!.id);
  });
}

/**
 * Edits apply to actions not yet run: pending ones are cancelled and re-planned by the next
 * matching event. Simpler and more predictable than rewriting queued rows in place.
 */
export async function updateWorkflow(deps: Deps, ctx: TenantContext, id: string, input: z.output<typeof workflowSchema>, meta: RequestMeta) {
  return withTransaction(deps.pool, async (tx) => {
    const before = await getWorkflow(tx, ctx, id);
    await checkTemplates(tx, ctx, input);
    await query(
      tx,
      sql`UPDATE workflows SET name = ${input.name}, description = ${input.description ?? null}, trigger_type = ${input.triggerType},
            trigger_config = ${JSON.stringify(input.triggerConfig)}, conditions = ${JSON.stringify(input.conditions)},
            actions = ${JSON.stringify(input.actions)}, requires_approval = ${input.requiresApproval}, is_active = ${input.isActive},
            version = version + 1
          WHERE id = ${id}`,
    );
    if (timingChanged(before, input)) {
      await query(tx, sql`UPDATE scheduled_actions SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'Automation edited' WHERE workflow_id = ${id} AND status = 'scheduled'`);
    }
    await recordAudit(tx, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: 'workflow.updated', entityType: 'workflow', entityId: id, before, after: input, meta });
    return getWorkflow(tx, ctx, id);
  });
}

const timingChanged = (a: WorkflowDto, b: z.output<typeof workflowSchema>) =>
  a.triggerType !== b.triggerType || JSON.stringify(a.triggerConfig) !== JSON.stringify(b.triggerConfig) || JSON.stringify(a.actions) !== JSON.stringify(b.actions);

/** Switching off keeps the plan; the executor skips actions of inactive workflows at run time. */
export async function setActive(deps: Deps, ctx: TenantContext, id: string, isActive: boolean, meta: RequestMeta) {
  return withTransaction(deps.pool, async (tx) => {
    await getWorkflow(tx, ctx, id);
    await query(tx, sql`UPDATE workflows SET is_active = ${isActive} WHERE id = ${id}`);
    await recordAudit(tx, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: isActive ? 'workflow.enabled' : 'workflow.disabled', entityType: 'workflow', entityId: id, meta });
    return getWorkflow(tx, ctx, id);
  });
}

export async function duplicateWorkflow(deps: Deps, ctx: TenantContext, id: string, meta: RequestMeta) {
  const w = await getWorkflow(deps.pool, ctx, id);
  return createWorkflow(
    deps,
    ctx,
    { name: `${w.name} (copy)`.slice(0, 255), description: w.description, triggerType: w.triggerType, triggerConfig: w.triggerConfig, conditions: w.conditions, actions: w.actions, requiresApproval: w.requiresApproval, isActive: false },
    meta,
  );
}

export async function deleteWorkflow(deps: Deps, ctx: TenantContext, id: string, meta: RequestMeta) {
  await withTransaction(deps.pool, async (tx) => {
    const before = await getWorkflow(tx, ctx, id);
    await query(tx, sql`UPDATE scheduled_actions SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'Automation deleted' WHERE workflow_id = ${id} AND status = 'scheduled'`);
    // History (scheduled actions, notifications) keeps pointing at it, so it's retired rather than removed.
    await query(tx, sql`UPDATE workflows SET is_active = false, name = left('[deleted] ' || name, 255), trigger_type = 'DELETED' WHERE id = ${id}`);
    await recordAudit(tx, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: 'workflow.deleted', entityType: 'workflow', entityId: id, before, meta });
  });
}

const TARGET_LOOKUP: Record<string, { table: string; label: ReturnType<typeof sql> }> = {
  hearing: { table: 'hearings', label: sql`(SELECT to_char(t.scheduled_date, 'DD Mon YYYY') || ' · ' || COALESCE(c.case_number, c.title, '') FROM cases c WHERE c.id = t.case_id)` },
  invoice: { table: 'invoices', label: sql`COALESCE(t.invoice_number, 'Draft invoice')` },
  payment: { table: 'payments', label: sql`COALESCE(t.receipt_number, 'Payment')` },
  task: { table: 'tasks', label: sql`t.title` },
  matter: { table: 'matters', label: sql`t.title` },
  case: { table: 'cases', label: sql`COALESCE(t.case_number, t.title)` },
};

/** "Test this automation" (PRD §9.5): what would happen for a real record, without doing it. */
export async function dryRun(deps: Deps, ctx: TenantContext, id: string, targetId: string | undefined): Promise<WorkflowDryRunDto> {
  const wf = await getWorkflow(deps.pool, ctx, id);
  const probe = targetOf({ event_type: wf.triggerType === 'HEARING_SCHEDULED' ? 'HEARING_SCHEDULED' : wf.triggerType, payload: {}, aggregate_id: targetId ?? '00000000-0000-0000-0000-000000000000' });
  if (!probe) return { target: null, conditionsMet: false, conditionResults: [], plan: [], note: 'This trigger has nothing to test against.' };
  const look = TARGET_LOOKUP[probe.type]!;
  const t = await queryOne<{ id: string; label: string }>(
    deps.pool,
    sql`SELECT t.id, ${look.label} AS label FROM ${sql.raw(look.table)} t
        WHERE t.organization_id = ${ctx.organizationId} ${targetId ? sql`AND t.id = ${targetId}` : sql.empty}
        ORDER BY t.created_at DESC LIMIT 1`,
  );
  if (!t) return { target: null, conditionsMet: false, conditionResults: [], plan: [], note: targetId ? 'Record not found.' : `No ${probe.type} yet to test with.` };
  const now = new Date();
  const real = targetOf({ event_type: wf.triggerType, payload: {}, aggregate_id: t.id })!;
  const context = await buildContext(deps.pool, ctx.organizationId, real.refs, now, deps.env.APP_URL);
  const flat = flatten(context.vars);
  const conditionResults = wf.conditions.map((c) => ({ field: c.field, operator: c.operator, expected: c.value ?? null, ...evaluateCondition(c, flat) }));
  const anchor = anchorDate(wf.triggerConfig, context);
  const runAt = await computeRunAt(deps.pool, ctx.organizationId, wf.triggerConfig, anchor, now);
  const plan = runAt
    ? wf.actions.map((a) => ({
        runAt: runAt.toISOString(),
        inPast: wf.triggerConfig.timing === 'relative' && runAt < now,
        action: ACTION_LABELS[a.type],
        detail: a.type === 'notify' ? `${RECIPIENT_LABELS[a.recipient]} · ${a.templateKey}` : a.type === 'create_task' ? a.title : a.type === 'add_tag' ? a.tag : a.type === 'add_timeline' ? a.title : '',
      }))
    : [];
  return {
    target: { type: real.type, id: t.id, label: t.label },
    conditionsMet: conditionResults.every((r) => r.passed),
    conditionResults,
    plan,
    note: !runAt ? 'The record has no date to time this against.' : plan.some((p) => p.inPast) ? 'That time has already passed for this record, so nothing would be sent.' : null,
  };
}
