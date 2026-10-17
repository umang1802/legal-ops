import { CONDITION_OPERATORS, NOTIFICATION_STATUSES, NOTIFY_RECIPIENTS, PRIORITIES, WORKFLOW_TRIGGERS } from '@legalops/types';
import { z } from 'zod';
import { uuidSchema } from './common.js';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: 'Use HH:MM (24h)' });

export const workflowTimingSchema = z.discriminatedUnion('timing', [
  z.object({ timing: z.literal('immediate') }).strict(),
  z
    .object({
      timing: z.literal('relative'),
      anchor: z.enum(['hearing.date', 'invoice.due_date', 'task.due_date']),
      offsetDays: z.number().int().min(-90, { error: 'At most 90 days before' }).max(90, { error: 'At most 90 days after' }),
      at: time,
    })
    .strict(),
]);

export const workflowConditionSchema = z
  .object({
    field: z.string().regex(/^[a-z_]+\.[a-z_]+$/, { error: 'Unknown field' }),
    operator: z.enum(CONDITION_OPERATORS),
    value: z.union([z.string().max(200), z.number()]).nullable().optional(),
  })
  .strict();

export const workflowActionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('notify'),
      channel: z.literal('email'),
      recipient: z.enum(NOTIFY_RECIPIENTS),
      templateKey: z.string().regex(/^[a-z0-9_]{2,100}$/, { error: 'Choose a template' }),
    })
    .strict(),
  z
    .object({
      type: z.literal('create_task'),
      title: z.string().trim().min(1, { error: 'Name the task' }).max(255),
      assignTo: z.enum(['lead', 'assignee', 'owners']),
      dueInDays: z.number().int().min(0).max(365).nullable().optional(),
      priority: z.enum(PRIORITIES).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('update_task'),
      priority: z.enum(PRIORITIES).optional(),
      status: z.enum(['todo', 'in_progress', 'blocked']).optional(),
    })
    .strict(),
  z.object({ type: z.literal('add_timeline'), title: z.string().trim().min(1).max(255) }).strict(),
  z.object({ type: z.literal('add_tag'), tag: z.string().trim().min(1).max(40) }).strict(),
]);

const anchorFor: Record<string, string> = { HEARING_SCHEDULED: 'hearing.date', INVOICE_CREATED: 'invoice.due_date', TASK_CREATED: 'task.due_date' };

const workflowBody = {
  name: z.string().trim().min(1, { error: 'Name the automation' }).max(255),
  description: z.string().trim().max(2000).nullable().optional(),
  triggerType: z.enum(WORKFLOW_TRIGGERS),
  triggerConfig: workflowTimingSchema,
  conditions: z.array(workflowConditionSchema).max(10).default([]),
  actions: z.array(workflowActionSchema).min(1, { error: 'Add at least one action' }).max(10),
  requiresApproval: z.boolean().default(false),
  isActive: z.boolean().default(true),
};

const coherent = (v: { triggerType: string; triggerConfig: z.infer<typeof workflowTimingSchema>; actions: z.infer<typeof workflowActionSchema>[] }, ctx: z.RefinementCtx) => {
  if (v.triggerConfig.timing === 'relative' && anchorFor[v.triggerType] !== v.triggerConfig.anchor) {
    ctx.addIssue({ code: 'custom', path: ['triggerConfig', 'anchor'], message: 'This trigger has no such date to time against' });
  }
  const taskTrigger = v.triggerType === 'TASK_CREATED' || v.triggerType === 'TASK_COMPLETED';
  v.actions.forEach((a, i) => {
    if (a.type === 'update_task' && !taskTrigger) ctx.addIssue({ code: 'custom', path: ['actions', i, 'type'], message: 'Only task triggers can update the task' });
    if (a.type === 'notify' && a.recipient === 'assignee' && !taskTrigger) ctx.addIssue({ code: 'custom', path: ['actions', i, 'recipient'], message: 'Only task triggers have an assignee' });
    if (a.type === 'create_task' && a.assignTo === 'assignee' && !taskTrigger) ctx.addIssue({ code: 'custom', path: ['actions', i, 'assignTo'], message: 'Only task triggers have an assignee' });
  });
};

export const workflowSchema = z.object(workflowBody).strict().superRefine(coherent);
export type WorkflowInput = z.input<typeof workflowSchema>;

export const workflowDryRunSchema = z.object({ targetId: uuidSchema.optional() }).strict();

export const templateSchema = z
  .object({
    templateKey: z.string().regex(/^[a-z0-9_]{2,100}$/, { error: 'Lowercase letters, digits and _' }),
    name: z.string().trim().min(1).max(255),
    audience: z.enum(['client', 'internal']),
    subjectTemplate: z.string().trim().min(1, { error: 'Enter a subject' }).max(500),
    htmlBody: z.string().trim().min(1, { error: 'Enter the message' }).max(50000),
    textBody: z.string().max(50000).nullable().optional(),
    isActive: z.boolean().default(true),
  })
  .strict();
export type TemplateInput = z.input<typeof templateSchema>;

export const templatePreviewSchema = z
  .object({
    audience: z.enum(['client', 'internal']).default('internal'),
    subjectTemplate: z.string().max(500),
    htmlBody: z.string().max(50000),
    matterId: uuidSchema.optional(),
  })
  .strict();

export const sendEmailSchema = z
  .object({
    clientId: uuidSchema,
    matterId: uuidSchema.nullable().optional(),
    templateKey: z.string().regex(/^[a-z0-9_]{2,100}$/).default('client_update'),
    customNote: z.string().trim().max(5000).nullable().optional(),
  })
  .strict();

export const listNotificationsSchema = z.object({
  status: z.enum([...NOTIFICATION_STATUSES, 'all', 'scheduled', 'problem']).default('all'),
  clientId: uuidSchema.optional(),
  matterId: uuidSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
