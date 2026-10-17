import type { WorkflowAction, WorkflowCondition, WorkflowTiming, WorkflowTrigger } from '@legalops/types';
import { query, queryOne, type Db } from '../../db/pool.js';
import { sql } from '../../db/sql.js';

type Default = {
  key: string;
  name: string;
  description: string;
  trigger: WorkflowTrigger;
  timing: WorkflowTiming;
  conditions?: WorkflowCondition[];
  actions: WorkflowAction[];
};

const rel = (anchor: 'hearing.date' | 'invoice.due_date' | 'task.due_date', offsetDays: number, at: string): WorkflowTiming => ({ timing: 'relative', anchor, offsetDays, at });
const email = (recipient: 'client' | 'lead' | 'matter_team' | 'assignee' | 'owners' | 'finance', templateKey: string): WorkflowAction => ({ type: 'notify', channel: 'email', recipient, templateKey });

/** PRD §42 default automation recipes. Seeded on, editable and switchable per firm. */
export const DEFAULT_WORKFLOWS: Default[] = [
  { key: 'hearing_7d_lead', name: 'Hearing in 7 days: remind lead lawyer', description: 'Early heads-up to prepare.', trigger: 'HEARING_SCHEDULED', timing: rel('hearing.date', -7, '09:00'), actions: [email('lead', 'hearing_reminder_internal')] },
  { key: 'hearing_3d_team', name: 'Hearing in 3 days: remind the matter team', description: 'Lawyers and clerks on the matter.', trigger: 'HEARING_SCHEDULED', timing: rel('hearing.date', -3, '09:00'), actions: [email('matter_team', 'hearing_reminder_internal')] },
  { key: 'hearing_1d_client', name: 'Hearing tomorrow: remind the client', description: 'Sent the day before at 9 am.', trigger: 'HEARING_SCHEDULED', timing: rel('hearing.date', -1, '09:00'), actions: [email('client', 'hearing_reminder_client')] },
  { key: 'hearing_morning_lead', name: 'Hearing today: morning reminder to lead lawyer', description: 'Sent at 8 am on the day.', trigger: 'HEARING_SCHEDULED', timing: rel('hearing.date', 0, '08:00'), actions: [email('lead', 'hearing_reminder_internal')] },
  { key: 'hearing_1d_team', name: 'Hearing tomorrow: brief the matter team', description: 'Sent at 5 pm the day before, with the last hearing’s notes.', trigger: 'HEARING_SCHEDULED', timing: rel('hearing.date', -1, '17:00'), actions: [email('matter_team', 'hearing_reminder_internal')] },
  { key: 'hearing_morning_client', name: 'Hearing today: morning reminder to the client', description: 'Sent at 7:30 am on the day.', trigger: 'HEARING_SCHEDULED', timing: rel('hearing.date', 0, '07:30'), actions: [email('client', 'hearing_today_client')] },
  {
    key: 'hearing_outcome_client',
    name: 'After a hearing: update the client with the next date',
    description: 'Only when a next date was recorded.',
    trigger: 'HEARING_COMPLETED',
    timing: { timing: 'immediate' },
    conditions: [{ field: 'hearing.next_date', operator: 'is_not_empty' }],
    actions: [email('client', 'hearing_outcome_client')],
  },
  { key: 'task_assigned', name: 'Task assigned: email the assignee', description: 'Not sent when you assign a task to yourself.', trigger: 'TASK_CREATED', timing: { timing: 'immediate' }, actions: [email('assignee', 'task_assigned')] },
  { key: 'invoice_issued', name: 'Invoice issued: email it to the client', description: 'Sent as soon as the invoice is issued.', trigger: 'INVOICE_CREATED', timing: { timing: 'immediate' }, actions: [email('client', 'invoice_issued')] },
  { key: 'invoice_due_3d', name: 'Invoice due in 3 days: reminder', description: 'Skipped automatically if already paid.', trigger: 'INVOICE_CREATED', timing: rel('invoice.due_date', -3, '10:00'), actions: [email('client', 'invoice_reminder')] },
  { key: 'invoice_due_today', name: 'Invoice due today: reminder', description: 'Skipped automatically if already paid.', trigger: 'INVOICE_CREATED', timing: rel('invoice.due_date', 0, '10:00'), actions: [email('client', 'invoice_reminder')] },
  { key: 'invoice_overdue_3d', name: 'Invoice 3 days overdue: reminder', description: 'Skipped automatically if paid.', trigger: 'INVOICE_CREATED', timing: rel('invoice.due_date', 3, '10:00'), actions: [email('client', 'invoice_reminder')] },
  {
    key: 'invoice_overdue_7d',
    name: 'Invoice 7 days overdue: reminder + alert lead lawyer',
    description: 'Client reminder and an internal escalation.',
    trigger: 'INVOICE_CREATED',
    timing: rel('invoice.due_date', 7, '10:00'),
    actions: [email('client', 'invoice_reminder'), email('lead', 'invoice_escalation_internal')],
  },
  { key: 'invoice_overdue_15d', name: 'Invoice 15 days overdue: escalate to partners', description: 'Internal only.', trigger: 'INVOICE_CREATED', timing: rel('invoice.due_date', 15, '10:00'), actions: [email('owners', 'invoice_escalation_internal')] },
  { key: 'payment_received', name: 'Payment received: confirm to the client', description: 'Includes the receipt number and remaining balance.', trigger: 'PAYMENT_RECEIVED', timing: { timing: 'immediate' }, actions: [email('client', 'payment_received')] },
];

/** Idempotent: adds any of the given default recipes the firm doesn't have (existing ones, edited or not, are left alone). */
export async function ensureDefaultWorkflows(db: Db, organizationId: string, createdBy: string | null, defaults: Default[] = DEFAULT_WORKFLOWS): Promise<number> {
  let added = 0;
  for (const d of defaults) {
    const rows = await query(
      db,
      sql`INSERT INTO workflows (organization_id, system_key, name, description, trigger_type, trigger_config, conditions, actions, created_by)
          VALUES (${organizationId}, ${d.key}, ${d.name}, ${d.description}, ${d.trigger}, ${JSON.stringify(d.timing)},
                  ${JSON.stringify(d.conditions ?? [])}, ${JSON.stringify(d.actions)}, ${createdBy})
          ON CONFLICT (organization_id, system_key) WHERE system_key IS NOT NULL DO NOTHING
          RETURNING id`,
    );
    added += rows.length;
  }
  return added;
}

/**
 * Offers each default recipe to a firm exactly once (D-013). Offered keys are remembered in
 * settings.seededWorkflowKeys, so new defaults reach existing firms, and a recipe a firm
 * deliberately deleted never comes back. Returns the keys added by this call.
 */
export async function ensureDefaultsOnce(db: Db, organizationId: string): Promise<string[]> {
  const org = await queryOne<{ keys: string[] }>(
    db,
    sql`SELECT COALESCE(settings->'seededWorkflowKeys', '[]'::jsonb) AS keys FROM organizations WHERE id = ${organizationId} FOR UPDATE`,
  );
  if (!org) return [];
  const pending = DEFAULT_WORKFLOWS.filter((d) => !org.keys.includes(d.key));
  if (!pending.length) return [];
  await ensureDefaultWorkflows(db, organizationId, null, pending);
  await query(
    db,
    sql`UPDATE organizations SET settings = jsonb_set(settings, '{seededWorkflowKeys}', ${JSON.stringify([...org.keys, ...pending.map((d) => d.key)])}::jsonb)
        WHERE id = ${organizationId}`,
  );
  return pending.map((d) => d.key);
}
