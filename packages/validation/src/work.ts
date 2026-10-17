import { HEARING_STATUSES, PRIORITIES, TASK_STATUSES } from '@legalops/types';
import { z } from 'zod';
import { uuidSchema } from './common.js';
import { nullableText } from './fields.js';

const isoDate = z.iso.date({ error: 'Use a valid date' });
const nullableTime = z
  .string()
  .nullable()
  .optional()
  .transform((v) => (v === '' ? null : v))
  .refine((v) => v == null || /^([01]\d|2[0-3]):[0-5]\d$/.test(v), { error: 'Use HH:MM (24h)' });

const hearingFields = {
  scheduledDate: isoDate,
  startTime: nullableTime,
  endTime: nullableTime,
  courtroom: nullableText(100),
  benchJudge: nullableText(255),
  hearingType: nullableText(100),
  notes: nullableText(5000),
};

const timesOrdered = (v: { startTime?: string | null | undefined; endTime?: string | null | undefined }) =>
  !v.startTime || !v.endTime || v.endTime > v.startTime;

export const createHearingSchema = z
  .object({ caseId: uuidSchema, ...hearingFields })
  .strict()
  .refine(timesOrdered, { path: ['endTime'], error: 'End time must be after start time' });
export type CreateHearingInput = z.input<typeof createHearingSchema>;

export const updateHearingSchema = z
  .object({
    scheduledDate: isoDate.optional(),
    startTime: hearingFields.startTime,
    endTime: hearingFields.endTime,
    courtroom: hearingFields.courtroom,
    benchJudge: hearingFields.benchJudge,
    hearingType: hearingFields.hearingType,
    notes: hearingFields.notes,
  })
  .strict()
  .refine(timesOrdered, { path: ['endTime'], error: 'End time must be after start time' });
export type UpdateHearingInput = z.input<typeof updateHearingSchema>;

/** A follow-up action captured while recording a hearing outcome (Journey C). */
export const nextActionSchema = z
  .object({
    title: z.string().trim().min(1, { error: 'Describe the task' }).max(255),
    assigneeId: uuidSchema.nullable().optional(),
    dueDate: isoDate.nullable().optional(),
  })
  .strict();

export const completeHearingSchema = z
  .object({
    result: z.enum(['completed', 'adjourned']),
    outcome: z.string().trim().min(1, { error: 'Summarise what happened' }).max(5000),
    nextHearingDate: isoDate.nullable().optional(),
    nextStartTime: nullableTime,
    notes: nullableText(5000),
    nextActions: z.array(nextActionSchema).max(10).default([]),
  })
  .strict();
export type CompleteHearingInput = z.input<typeof completeHearingSchema>;

export const cancelHearingSchema = z
  .object({ reason: z.string().trim().min(1, { error: 'Give a reason' }).max(1000) })
  .strict();

export const listHearingsSchema = z
  .object({
    from: isoDate.optional(),
    until: isoDate.optional(),
    status: z.enum([...HEARING_STATUSES, 'pending_outcome', 'active']).optional(),
    caseId: uuidSchema.optional(),
    matterId: uuidSchema.optional(),
    lawyerId: uuidSchema.optional(),
  })
  .refine((v) => !v.from || !v.until || v.until >= v.from, {
    path: ['until'],
    error: 'until must be on/after from',
  })
  .refine((v) => !v.from || !v.until || (Date.parse(v.until) - Date.parse(v.from)) / 86_400_000 <= 92, {
    path: ['until'],
    error: 'Range can be at most 3 months',
  });

const taskFields = {
  title: z.string().trim().min(1, { error: 'Describe the task' }).max(255),
  description: nullableText(5000),
  priority: z.enum(PRIORITIES).default('normal'),
  dueDate: isoDate.nullable().optional(),
  dueTime: nullableTime,
  assigneeId: uuidSchema.nullable().optional(),
};

export const createTaskSchema = z
  .object({
    ...taskFields,
    matterId: uuidSchema.nullable().optional(),
    caseId: uuidSchema.nullable().optional(),
    hearingId: uuidSchema.nullable().optional(),
  })
  .strict()
  .refine((v) => !v.dueTime || v.dueDate, { path: ['dueTime'], error: 'Pick a due date first' });
export type CreateTaskInput = z.input<typeof createTaskSchema>;

export const updateTaskSchema = z
  .object({
    title: taskFields.title.optional(),
    description: taskFields.description,
    priority: z.enum(PRIORITIES).optional(),
    status: z.enum(TASK_STATUSES).exclude(['done']).optional(),
    dueDate: taskFields.dueDate,
    dueTime: taskFields.dueTime,
  })
  .strict();
export type UpdateTaskInput = z.input<typeof updateTaskSchema>;

export const reassignTaskSchema = z.object({ assigneeId: uuidSchema.nullable() }).strict();
export const taskCommentSchema = z.object({ body: z.string().trim().min(1).max(5000) }).strict();

export const listTasksSchema = z.object({
  view: z.enum(['mine', 'team', 'overdue', 'completed', 'all']).default('mine'),
  matterId: uuidSchema.optional(),
  hearingId: uuidSchema.optional(),
  assigneeId: uuidSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export const listCasesSchema = z.object({
  search: z.string().trim().max(100).optional(),
  matterId: uuidSchema.optional(),
});
