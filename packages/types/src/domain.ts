/** Enum values mirror the CHECK constraints in packages/db/migrations/0001_init.sql. */

export const CLIENT_TYPES = ['person', 'company'] as const;
export type ClientType = (typeof CLIENT_TYPES)[number];
export const CLIENT_STATUSES = ['active', 'inactive', 'archived'] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

export const MATTER_STATUSES = ['lead', 'active', 'on_hold', 'closed', 'archived'] as const;
export type MatterStatus = (typeof MATTER_STATUSES)[number];
export const MATTER_STATUS_LABELS: Record<MatterStatus, string> = {
  lead: 'Lead',
  active: 'Active',
  on_hold: 'On hold',
  closed: 'Closed',
  archived: 'Archived',
};

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABELS: Record<Priority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

export const MATTER_STAFF_ROLES = ['lead', 'associate', 'support'] as const;
export type MatterStaffRole = (typeof MATTER_STAFF_ROLES)[number];
export const MATTER_STAFF_ROLE_LABELS: Record<MatterStaffRole, string> = {
  lead: 'Lead lawyer',
  associate: 'Associate',
  support: 'Support',
};

export const CASE_STATUSES = [
  'pending_filing',
  'active',
  'reserved',
  'disposed',
  'withdrawn',
  'transferred',
  'closed',
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];
export const CASE_STATUS_LABELS: Record<CaseStatus, string> = {
  pending_filing: 'Pending filing',
  active: 'Active',
  reserved: 'Reserved for orders',
  disposed: 'Disposed',
  withdrawn: 'Withdrawn',
  transferred: 'Transferred',
  closed: 'Closed',
};

export const PARTY_SIDES = [
  'petitioner',
  'plaintiff',
  'appellant',
  'respondent',
  'defendant',
  'other',
] as const;
export type PartySide = (typeof PARTY_SIDES)[number];
export const PARTY_SIDE_LABELS: Record<PartySide, string> = {
  petitioner: 'Petitioner',
  plaintiff: 'Plaintiff',
  appellant: 'Appellant',
  respondent: 'Respondent',
  defendant: 'Defendant',
  other: 'Other',
};

export const PRACTICE_AREAS = [
  'Civil',
  'Criminal',
  'Commercial',
  'Family',
  'Property',
  'Labour',
  'Tax',
  'Consumer',
  'Arbitration',
  'Constitutional',
  'Corporate',
  'Other',
] as const;

export const HEARING_STATUSES = ['scheduled', 'completed', 'adjourned', 'cancelled', 'unknown'] as const;
export type HearingStatus = (typeof HEARING_STATUSES)[number];
export const HEARING_STATUS_LABELS: Record<HearingStatus, string> = {
  scheduled: 'Scheduled',
  completed: 'Heard',
  adjourned: 'Adjourned',
  cancelled: 'Cancelled',
  unknown: 'Unknown',
};

export const HEARING_TYPES = [
  'Admission',
  'Arguments',
  'Evidence',
  'Cross-examination',
  'Framing of issues',
  'Interim application',
  'Orders',
  'Mention',
  'Final hearing',
  'Other',
] as const;

export const TASK_STATUSES = ['todo', 'in_progress', 'blocked', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
};
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'blocked'];

export const INVOICE_STATUSES = ['draft', 'issued', 'void', 'written_off'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export type PaymentState = 'unpaid' | 'partial' | 'paid';
/** One label for the combined lifecycle + payment state shown to users. */
export type InvoiceDisplayStatus =
  'draft' | 'unpaid' | 'partial' | 'paid' | 'overdue' | 'void' | 'written_off';
export const INVOICE_DISPLAY_LABELS: Record<InvoiceDisplayStatus, string> = {
  draft: 'Draft',
  unpaid: 'Issued',
  partial: 'Partially paid',
  paid: 'Paid',
  overdue: 'Overdue',
  void: 'Void',
  written_off: 'Written off',
};

export const PAYMENT_METHODS = ['upi', 'bank_transfer', 'cash', 'cheque', 'card', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  upi: 'UPI',
  bank_transfer: 'Bank transfer',
  cash: 'Cash',
  cheque: 'Cheque',
  card: 'Card',
  other: 'Other',
};

export const FEE_AGREEMENT_TYPES = ['fixed', 'retainer', 'milestone', 'per_appearance', 'hybrid'] as const;
export type FeeAgreementType = (typeof FEE_AGREEMENT_TYPES)[number];
export const FEE_AGREEMENT_TYPE_LABELS: Record<FeeAgreementType, string> = {
  fixed: 'Fixed fee',
  retainer: 'Retainer',
  milestone: 'Milestones',
  per_appearance: 'Per appearance',
  hybrid: 'Hybrid',
};

export const EXPENSE_CATEGORIES = [
  'Court fees',
  'Stamp duty',
  'Filing & process fees',
  'Certified copies',
  'Travel',
  'Courier',
  'Typing & printing',
  'Counsel fees',
  'Other',
] as const;

export const AGING_BUCKETS = ['0-7', '8-30', '31-60', '61+'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];
