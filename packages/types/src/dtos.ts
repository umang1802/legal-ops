import type {
  CaseStatus,
  ClientStatus,
  AgingBucket,
  ClientType,
  FeeAgreementType,
  HearingStatus,
  InvoiceDisplayStatus,
  InvoiceStatus,
  MatterStaffRole,
  MatterStatus,
  PartySide,
  PaymentMethod,
  PaymentState,
  Priority,
  TaskStatus,
} from './domain.js';

export type UserRef = { userId: string; firstName: string; lastName: string | null };

export type ClientDto = {
  id: string;
  clientType: ClientType;
  name: string;
  email: string | null;
  phone: string | null;
  alternatePhone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  stateCode: string | null;
  gstin: string | null;
  pan: string | null;
  notes: string | null;
  tags: string[];
  emailNotificationsEnabled: boolean;
  status: ClientStatus;
  createdAt: string;
  updatedAt: string;
};

export type ClientListItemDto = Pick<
  ClientDto,
  'id' | 'clientType' | 'name' | 'email' | 'phone' | 'status' | 'city'
> & {
  /** Matters the caller can see, not the firm-wide count. */
  activeMatterCount: number;
};

export type DuplicateCandidate = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  matchedOn: ('email' | 'phone' | 'name')[];
};

export type MatterStaffDto = UserRef & { role: MatterStaffRole };

export type MatterListItemDto = {
  id: string;
  title: string;
  referenceCode: string | null;
  practiceArea: string | null;
  status: MatterStatus;
  priority: Priority;
  client: { id: string; name: string };
  lead: UserRef | null;
  primaryCase: { id: string; caseNumber: string | null; cnr: string | null; courtName: string | null } | null;
  caseCount: number;
  nextHearingDate: string | null;
  updatedAt: string;
};

export type MatterDetailDto = Omit<MatterListItemDto, 'primaryCase' | 'caseCount'> & {
  startDate: string | null;
  closeDate: string | null;
  internalNotes: string | null;
  clientSummary: string | null;
  tags: string[];
  staff: MatterStaffDto[];
  cases: CaseSummaryDto[];
  createdAt: string;
};

export type CourtDto = {
  id: string;
  name: string;
  courtType: string | null;
  city: string | null;
  state: string | null;
  isGlobal: boolean;
};

export type CaseSummaryDto = {
  id: string;
  title: string;
  caseNumber: string | null;
  cnr: string | null;
  caseType: string | null;
  status: CaseStatus;
  court: { id: string; name: string } | null;
  nextHearingDate: string | null;
};

export type PartyDto = {
  id: string;
  name: string;
  partyType: string | null;
  side: PartySide | null;
  isClient: boolean;
  email: string | null;
  phone: string | null;
};

export type AdvocateDto = {
  id: string;
  name: string;
  firmName: string | null;
  enrollmentNumber: string | null;
  phone: string | null;
  email: string | null;
  isInternal: boolean;
  side: PartySide | null;
  isLead: boolean;
};

export type CaseDetailDto = CaseSummaryDto & {
  matter: { id: string; title: string; client: { id: string; name: string } };
  filingDate: string | null;
  registrationDate: string | null;
  judgeBench: string | null;
  externalProvider: string | null;
  lastSyncedAt: string | null;
  parties: PartyDto[];
  advocates: AdvocateDto[];
  createdAt: string;
  updatedAt: string;
};

export type TimelineEventDto = {
  id: string;
  eventType: string;
  title: string;
  description: string | null;
  actor: UserRef | null;
  actorType: 'user' | 'system' | 'workflow' | 'provider';
  caseId: string | null;
  createdAt: string;
};

export type SearchResultsDto = {
  clients: { id: string; name: string; email: string | null; phone: string | null }[];
  matters: { id: string; title: string; referenceCode: string | null; clientName: string }[];
  cases: { id: string; title: string; caseNumber: string | null; cnr: string | null; matterId: string }[];
  invoices: { id: string; invoiceNumber: string; matterId: string; clientName: string }[];
};

export type HearingDto = {
  id: string;
  caseId: string;
  caseNumber: string | null;
  cnr: string | null;
  caseTitle: string;
  matterId: string;
  matterTitle: string;
  clientName: string;
  courtName: string | null;
  scheduledDate: string;
  startTime: string | null;
  endTime: string | null;
  courtroom: string | null;
  benchJudge: string | null;
  hearingType: string | null;
  status: HearingStatus;
  outcome: string | null;
  /** Client-facing summary of the hearing. `outcome` is the team's internal note and is never emailed to clients. */
  clientSummary: string | null;
  nextHearingDate: string | null;
  nextHearingId: string | null;
  previousHearingId: string | null;
  notes: string | null;
  lead: UserRef | null;
  /** Date has passed but no outcome was recorded. */
  pendingOutcome: boolean;
  completedAt: string | null;
  cancelReason: string | null;
};

export type TaskDto = {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: Priority;
  /** Instant (UTC ISO) and the firm-local calendar date it falls on. */
  dueAt: string | null;
  dueDate: string | null;
  overdue: boolean;
  assignee: UserRef | null;
  createdBy: UserRef | null;
  completedBy: UserRef | null;
  completedAt: string | null;
  matter: { id: string; title: string } | null;
  caseId: string | null;
  hearingId: string | null;
  sourceEventId: string | null;
  createdAt: string;
};

export type TaskCommentDto = { id: string; body: string; author: UserRef | null; createdAt: string };

export type DashboardDto = {
  today: string;
  scope: 'firm' | 'mine';
  counts: {
    hearingsToday: number;
    tasksDueToday: number;
    overdueTasks: number;
    pendingOutcomes: number;
    /** null until billing (Phase 4) exists: the UI must not show a fabricated zero. */
    outstanding: string | null;
    overdueAmount: string | null;
  };
  hearingsToday: HearingDto[];
  upcomingHearings: HearingDto[];
  pendingOutcomes: HearingDto[];
  tasksDueToday: TaskDto[];
  overdueTasks: TaskDto[];
  recentChanges: (TimelineEventDto & { matter: { id: string; title: string } | null })[];
};

export type CaseListItemDto = CaseSummaryDto & { matter: { id: string; title: string }; clientName: string };

/** All money fields are decimal strings with 2 places ('50000.00'), never floats. */
export type Money = string;

export type InvoiceListItemDto = {
  id: string;
  invoiceNumber: string | null;
  status: InvoiceStatus;
  paymentState: PaymentState | null;
  displayStatus: InvoiceDisplayStatus;
  daysOverdue: number;
  issueDate: string | null;
  dueDate: string | null;
  client: { id: string; name: string };
  matter: { id: string; title: string };
  total: Money;
  amountPaid: Money;
  amountCredited: Money;
  amountDue: Money;
  currency: string;
};

export type InvoiceLineDto = {
  id: string;
  position: number;
  description: string;
  quantity: string;
  unitPrice: Money;
  amount: Money;
  sacCode: string | null;
  gstRate: string | null;
  isPureAgent: boolean;
  feeMilestoneId: string | null;
  expenseId: string | null;
};

export type InvoiceDetailDto = InvoiceListItemDto & {
  taxMode: 'simple' | 'gst';
  supplierGstin: string | null;
  supplierStateCode: string | null;
  recipientGstin: string | null;
  recipientStateCode: string | null;
  placeOfSupply: string | null;
  isReverseCharge: boolean;
  subtotal: Money;
  discountAmount: Money;
  cgst: Money;
  sgst: Money;
  igst: Money;
  rcmTax: Money;
  taxAmount: Money;
  notes: string | null;
  items: InvoiceLineDto[];
  allocations: {
    id: string;
    paymentId: string;
    receiptNumber: string;
    paymentDate: string;
    method: PaymentMethod;
    amount: Money;
    active: boolean;
  }[];
  creditNotes: { id: string; number: string; issueDate: string; amount: Money; reason: string }[];
  issuedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  writeOffReason: string | null;
  createdBy: UserRef | null;
  createdAt: string;
};

export type PaymentDto = {
  id: string;
  receiptNumber: string;
  client: { id: string; name: string };
  matter: { id: string; title: string } | null;
  amount: Money;
  tdsAmount: Money;
  /** amount + TDS: what this payment settles. */
  settlement: Money;
  unallocated: Money;
  paymentDate: string;
  method: PaymentMethod;
  referenceNumber: string | null;
  notes: string | null;
  status: 'posted' | 'reversed';
  recordedBy: UserRef | null;
  reversedAt: string | null;
  reversalReason: string | null;
  tdsCertificateNumber: string | null;
  tdsCertificateReceivedAt: string | null;
  allocations: {
    id: string;
    invoiceId: string;
    invoiceNumber: string | null;
    amount: Money;
    active: boolean;
    createdAt: string;
  }[];
  createdAt: string;
};

export type ExpenseDto = {
  id: string;
  matter: { id: string; title: string } | null;
  caseId: string | null;
  category: string | null;
  amount: Money;
  expenseDate: string;
  description: string | null;
  vendorName: string | null;
  billableToClient: boolean;
  reimbursable: boolean;
  status: 'recorded' | 'billed' | 'void';
  invoiceId: string | null;
  createdBy: UserRef | null;
  createdAt: string;
};

export type FeeMilestoneDto = {
  id: string;
  name: string;
  sequenceNo: number | null;
  amount: Money;
  dueDate: string | null;
  status: 'planned' | 'invoiced' | 'waived' | 'cancelled';
  invoiceId: string | null;
  invoiceNumber: string | null;
  invoiceDisplayStatus: InvoiceDisplayStatus | null;
};

export type FeeAgreementDto = {
  id: string;
  matterId: string;
  agreementType: FeeAgreementType;
  description: string | null;
  currency: string;
  agreedAmount: Money | null;
  perAppearanceAmount: Money | null;
  taxIncluded: boolean;
  effectiveDate: string | null;
  status: 'draft' | 'active' | 'completed' | 'cancelled';
  notes: string | null;
  milestones: FeeMilestoneDto[];
  createdAt: string;
};

export type BillingSummaryDto = {
  today: string;
  scope: 'firm' | 'mine';
  invoicedThisMonth: Money;
  receivedThisMonth: Money;
  outstanding: Money;
  overdue: Money;
  dueThisWeek: Money;
  unallocatedAdvances: Money;
  aging: Record<AgingBucket, { count: number; amount: Money }>;
  overdueInvoices: InvoiceListItemDto[];
  dueSoon: InvoiceListItemDto[];
  recentPayments: PaymentDto[];
};

export type MatterBillingDto = {
  invoiced: Money;
  paid: Money;
  credited: Money;
  outstanding: Money;
  overdue: Money;
  unbilledExpenses: Money;
};

export type ClientBalanceDto = { outstanding: Money; overdue: Money; advance: Money };

/** One line of the printable daily diary: the hearing plus what happened at the case's last held hearing. */
export type DiaryRowDto = HearingDto & {
  previous: { date: string; result: 'completed' | 'adjourned'; outcome: string | null } | null;
};

export type DiaryDto = { date: string; rows: DiaryRowDto[] };
