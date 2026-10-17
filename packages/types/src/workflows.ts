/**
 * Workflow vocabulary shared by the engine (API/worker) and the builder UI (PRD §9).
 * Trigger → conditions → timing → actions. Date-based reminders (due soon / overdue) are expressed as
 * timing relative to an anchor date on the triggering record, so no per-rule cron is needed.
 */

export const WORKFLOW_TRIGGERS = [
  'MATTER_CREATED',
  'CASE_CREATED',
  'CASE_STATUS_CHANGED',
  'HEARING_SCHEDULED',
  'HEARING_COMPLETED',
  'HEARING_CANCELLED',
  'TASK_CREATED',
  'TASK_COMPLETED',
  'INVOICE_CREATED',
  'INVOICE_PAID',
  'PAYMENT_RECEIVED',
] as const;
export type WorkflowTrigger = (typeof WORKFLOW_TRIGGERS)[number];

export const TRIGGER_LABELS: Record<WorkflowTrigger, string> = {
  MATTER_CREATED: 'Matter opened',
  CASE_CREATED: 'Case added',
  CASE_STATUS_CHANGED: 'Case status changed',
  HEARING_SCHEDULED: 'Hearing scheduled',
  HEARING_COMPLETED: 'Hearing outcome recorded',
  HEARING_CANCELLED: 'Hearing cancelled',
  TASK_CREATED: 'Task created',
  TASK_COMPLETED: 'Task completed',
  INVOICE_CREATED: 'Invoice issued',
  INVOICE_PAID: 'Invoice fully paid',
  PAYMENT_RECEIVED: 'Payment received',
};

/** Which date a trigger's actions can be timed against ("3 days before the hearing"). */
export const TRIGGER_ANCHORS: Partial<Record<WorkflowTrigger, { anchor: WorkflowAnchor; label: string }>> = {
  HEARING_SCHEDULED: { anchor: 'hearing.date', label: 'the hearing date' },
  INVOICE_CREATED: { anchor: 'invoice.due_date', label: 'the invoice due date' },
  TASK_CREATED: { anchor: 'task.due_date', label: 'the task due date' },
};
export type WorkflowAnchor = 'hearing.date' | 'invoice.due_date' | 'task.due_date';

export type WorkflowTiming =
  | { timing: 'immediate' }
  | { timing: 'relative'; anchor: WorkflowAnchor; offsetDays: number; at: string };

export const CONDITION_OPERATORS = [
  'equals',
  'not_equals',
  'greater_than',
  'less_than',
  'contains',
  'is_empty',
  'is_not_empty',
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];
export const OPERATOR_LABELS: Record<ConditionOperator, string> = {
  equals: 'is',
  not_equals: 'is not',
  greater_than: 'is more than',
  less_than: 'is less than',
  contains: 'contains',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
};

export type WorkflowCondition = { field: string; operator: ConditionOperator; value?: string | number | null };

/** Fields a condition can test, per trigger family. Values come from the engine's context builder. */
export const CONDITION_FIELDS: { field: string; label: string; triggers: readonly WorkflowTrigger[]; numeric?: boolean }[] = [
  { field: 'matter.status', label: 'Matter status', triggers: WORKFLOW_TRIGGERS },
  { field: 'matter.priority', label: 'Matter priority', triggers: WORKFLOW_TRIGGERS },
  { field: 'matter.practice_area', label: 'Practice area', triggers: WORKFLOW_TRIGGERS },
  { field: 'client.client_type', label: 'Client type (person/company)', triggers: WORKFLOW_TRIGGERS },
  { field: 'case.status', label: 'Case status', triggers: ['CASE_CREATED', 'CASE_STATUS_CHANGED', 'HEARING_SCHEDULED', 'HEARING_COMPLETED', 'HEARING_CANCELLED'] },
  { field: 'hearing.hearing_type', label: 'Hearing type', triggers: ['HEARING_SCHEDULED', 'HEARING_COMPLETED', 'HEARING_CANCELLED'] },
  { field: 'hearing.next_date', label: 'Next hearing date', triggers: ['HEARING_COMPLETED'] },
  { field: 'hearing.result', label: 'Hearing result (completed/adjourned)', triggers: ['HEARING_COMPLETED'] },
  { field: 'invoice.amount_due_rupees', label: 'Invoice amount due (₹)', triggers: ['INVOICE_CREATED', 'INVOICE_PAID'], numeric: true },
  { field: 'invoice.total_rupees', label: 'Invoice total (₹)', triggers: ['INVOICE_CREATED', 'INVOICE_PAID'], numeric: true },
  { field: 'task.priority', label: 'Task priority', triggers: ['TASK_CREATED', 'TASK_COMPLETED'] },
  { field: 'payment.amount_rupees', label: 'Payment amount (₹)', triggers: ['PAYMENT_RECEIVED'], numeric: true },
];

export const NOTIFY_RECIPIENTS = ['client', 'lead', 'matter_team', 'assignee', 'owners', 'finance'] as const;
export type NotifyRecipient = (typeof NOTIFY_RECIPIENTS)[number];
export const RECIPIENT_LABELS: Record<NotifyRecipient, string> = {
  client: 'Client',
  lead: 'Lead lawyer',
  matter_team: 'Everyone on the matter',
  assignee: 'Task assignee',
  owners: 'Partners (owners)',
  finance: 'Finance team',
};

export type WorkflowAction =
  | { type: 'notify'; channel: 'email'; recipient: NotifyRecipient; templateKey: string }
  | { type: 'create_task'; title: string; assignTo: 'lead' | 'assignee' | 'owners'; dueInDays?: number | null; priority?: 'low' | 'normal' | 'high' | 'urgent' }
  | { type: 'update_task'; priority?: 'low' | 'normal' | 'high' | 'urgent'; status?: 'todo' | 'in_progress' | 'blocked' }
  | { type: 'add_timeline'; title: string }
  | { type: 'add_tag'; tag: string };
export type WorkflowActionType = WorkflowAction['type'];
export const ACTION_LABELS: Record<WorkflowActionType, string> = {
  notify: 'Send email',
  create_task: 'Create task',
  update_task: 'Update the task',
  add_timeline: 'Add timeline note',
  add_tag: 'Tag the matter',
};

export type WorkflowDto = {
  id: string;
  name: string;
  description: string | null;
  systemKey: string | null;
  triggerType: WorkflowTrigger;
  triggerConfig: WorkflowTiming;
  conditions: WorkflowCondition[];
  actions: WorkflowAction[];
  requiresApproval: boolean;
  isActive: boolean;
  updatedAt: string;
  stats: { scheduled: number; done: number; lastRunAt: string | null };
};

export type WorkflowDryRunDto = {
  target: { type: string; id: string; label: string } | null;
  conditionsMet: boolean;
  conditionResults: { field: string; operator: ConditionOperator; expected: unknown; actual: unknown; passed: boolean }[];
  plan: { runAt: string; inPast: boolean; action: string; detail: string }[];
  note: string | null;
};

// ---------------------------------------------------------------------------
// Notifications & templates
// ---------------------------------------------------------------------------

export const NOTIFICATION_STATUSES = [
  'pending',
  'awaiting_approval',
  'queued',
  'sending',
  'sent',
  'delivered',
  'bounced',
  'complained',
  'failed',
  'skipped',
  'cancelled',
] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];
export const NOTIFICATION_STATUS_LABELS: Record<NotificationStatus, string> = {
  pending: 'Pending',
  awaiting_approval: 'Needs approval',
  queued: 'Scheduled',
  sending: 'Sending',
  sent: 'Sent',
  delivered: 'Delivered',
  bounced: 'Bounced',
  complained: 'Marked as spam',
  failed: 'Failed',
  skipped: 'Not sent',
  cancelled: 'Cancelled',
};
export const SKIP_REASON_LABELS: Record<string, string> = {
  client_opted_out: 'Client has email updates turned off',
  no_destination: 'No email address on file',
  user_opted_out: 'Recipient turned these emails off',
  user_inactive: 'Recipient is no longer active',
  target_changed: 'The hearing/invoice changed before sending',
  rejected: 'Rejected by a reviewer',
};

export type NotificationDto = {
  id: string;
  channel: 'email' | 'whatsapp' | 'sms' | 'push';
  notificationType: string;
  recipientType: 'client' | 'user' | 'external';
  recipientName: string | null;
  destination: string | null;
  client: { id: string; name: string } | null;
  matter: { id: string; title: string } | null;
  subject: string | null;
  status: NotificationStatus;
  skipReason: string | null;
  scheduledAt: string | null;
  sentAt: string | null;
  failedAt: string | null;
  failureReason: string | null;
  attempts: number;
  provider: string | null;
  providerMessageId: string | null;
  workflow: { id: string; name: string } | null;
  createdBy: { userId: string; firstName: string; lastName: string | null } | null;
  createdAt: string;
};

export type NotificationDetailDto = NotificationDto & { bodyHtml: string | null; bodyText: string | null; sensitive: boolean };

export type EmailTemplateDto = {
  id: string;
  templateKey: string;
  name: string;
  eventType: string | null;
  audience: 'client' | 'internal';
  subjectTemplate: string;
  htmlBody: string;
  textBody: string | null;
  isActive: boolean;
  isSystem: boolean;
  /** For system rows: whether this firm has its own version. */
  overridden: boolean;
  updatedAt: string;
};

export type TemplateVariable = { name: string; example: string; /** Team-only: never rendered in client emails. */ internalOnly?: true };

/** Variables the editor offers (rendered server-side, HTML-escaped). */
export const TEMPLATE_VARIABLES: { group: string; vars: TemplateVariable[] }[] = [
  { group: 'Firm', vars: [{ name: 'firm.name', example: 'Sharma & Associates' }, { name: 'firm.email', example: 'office@sharma.example.com' }, { name: 'firm.phone', example: '+91 11 4000 0000' }] },
  { group: 'Client', vars: [{ name: 'client.name', example: 'Raj Sharma' }] },
  { group: 'Matter', vars: [{ name: 'matter.title', example: 'Sharma v ABC' }, { name: 'matter.reference', example: 'SA-2026-001' }] },
  { group: 'Case', vars: [{ name: 'case.case_number', example: 'CS(OS) 412/2026' }, { name: 'case.court', example: 'Delhi High Court' }, { name: 'case.cnr', example: 'DLHC010004122026' }] },
  {
    group: 'Hearing',
    vars: [
      { name: 'hearing.date', example: 'Sat, 10 Oct 2026' },
      { name: 'hearing.time', example: '10:30 am' },
      { name: 'hearing.courtroom', example: '12' },
      { name: 'hearing.client_summary', example: 'The court gave the other side time to file a reply.' },
      { name: 'hearing.outcome', example: 'Judge unconvinced on limitation; consider settlement', internalOnly: true },
      { name: 'hearing.next_date', example: 'Thu, 22 Oct 2026' },
    ],
  },
  {
    group: 'Last hearing',
    vars: [
      { name: 'previous.date', example: '10 Oct 2026' },
      { name: 'previous.client_update', example: 'The court gave the other side time to file a reply.' },
      { name: 'previous.client_update_phrase', example: 'Update from the last hearing (10 Oct 2026): The court gave the other side time to file a reply.' },
      { name: 'previous.internal_note', example: 'Judge unconvinced on limitation', internalOnly: true },
      { name: 'previous.internal_note_phrase', example: 'Internal note from the last hearing: Judge unconvinced on limitation', internalOnly: true },
    ],
  },
  {
    group: 'Invoice',
    vars: [
      { name: 'invoice.number', example: 'LGL/2026-27/000001' },
      { name: 'invoice.total', example: '₹50,000.00' },
      { name: 'invoice.amount_due', example: '₹30,000.00' },
      { name: 'invoice.due_date', example: '15 Oct 2026' },
      { name: 'invoice.days_overdue', example: '7' },
    ],
  },
  { group: 'Payment', vars: [{ name: 'payment.amount', example: '₹20,000.00' }, { name: 'payment.receipt_number', example: 'RCPT/2026-27/000001' }, { name: 'payment.date', example: '3 Oct 2026' }] },
  { group: 'Task', vars: [{ name: 'task.title', example: 'Prepare written submissions' }, { name: 'task.due_date', example: '20 Oct 2026' }] },
  { group: 'Recipient', vars: [{ name: 'recipient.first_name', example: 'Meera' }] },
  { group: 'Manual update', vars: [{ name: 'custom.note', example: 'Please carry the original sale deed.' }] },
];

/** Variables that must never appear in, or render into, a client email. */
export const INTERNAL_ONLY_VARIABLES: readonly string[] = TEMPLATE_VARIABLES.flatMap((g) => g.vars.filter((v) => v.internalOnly).map((v) => v.name));
