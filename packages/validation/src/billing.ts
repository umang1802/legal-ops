import { FEE_AGREEMENT_TYPES, PAYMENT_METHODS } from '@legalops/types';
import { z } from 'zod';
import { uuidSchema } from './common.js';
import { nullableDate, nullableText } from './fields.js';

const isoDate = z.iso.date({ error: 'Use a valid date' });

/** Non-negative money as a 2-dp decimal string. Accepts numbers or strings ('50,000' commas allowed). */
export const moneySchema = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === 'number' ? v.toFixed(2) : v.trim().replace(/,/g, '')))
  .refine((v) => /^\d{1,12}(\.\d{1,2})?$/.test(v), { error: 'Enter an amount like 50000 or 1250.50' });

export const positiveMoneySchema = moneySchema.refine((v) => Number(v) > 0, {
  error: 'Must be more than zero',
});

const quantitySchema = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === 'number' ? String(v) : v.trim()))
  .refine((v) => /^\d{1,8}(\.\d{1,2})?$/.test(v) && Number(v) > 0, {
    error: 'Quantity must be a positive number',
  });

const gstRateSchema = z
  .union([z.string(), z.number()])
  .nullable()
  .optional()
  .transform((v) => (v === '' || v === undefined ? null : typeof v === 'number' ? String(v) : v))
  .refine((v) => v === null || (/^\d{1,2}(\.\d{1,2})?$/.test(v) && Number(v) <= 28), {
    error: 'GST rate must be 0–28%',
  });

export const invoiceItemSchema = z
  .object({
    description: z.string().trim().min(1, { error: 'Describe the item' }).max(500),
    quantity: quantitySchema.default('1'),
    unitPrice: moneySchema,
    sacCode: z
      .string()
      .trim()
      .nullable()
      .optional()
      .transform((v) => (v === '' ? null : v))
      .refine((v) => v == null || /^\d{4,8}$/.test(v), { error: 'SAC is 4–8 digits' }),
    gstRate: gstRateSchema,
    isPureAgent: z.boolean().default(false),
    feeMilestoneId: uuidSchema.nullable().optional(),
    expenseId: uuidSchema.nullable().optional(),
  })
  .strict();

const invoiceBody = {
  issueDate: nullableDate,
  dueDate: nullableDate,
  notes: nullableText(5000),
  discountAmount: moneySchema.default('0'),
  /** Simple tax mode only. Ignored in GST mode (computed). */
  taxAmount: moneySchema.default('0'),
  /** GST mode only. */
  isReverseCharge: z.boolean().optional(),
  placeOfSupply: z
    .string()
    .nullable()
    .optional()
    .transform((v) => (v === '' ? null : v))
    .refine((v) => v == null || /^\d{2}$/.test(v), { error: '2-digit state code' }),
  items: z.array(invoiceItemSchema).min(1, { error: 'Add at least one item' }).max(100),
};

const datesOrdered = (v: { issueDate?: string | null | undefined; dueDate?: string | null | undefined }) =>
  !v.issueDate || !v.dueDate || v.dueDate >= v.issueDate;

export const createInvoiceSchema = z
  .object({ matterId: uuidSchema, ...invoiceBody, issue: z.boolean().default(false) })
  .strict()
  .refine(datesOrdered, { path: ['dueDate'], error: 'Due date cannot be before the issue date' });
export type CreateInvoiceInput = z.input<typeof createInvoiceSchema>;

export const updateInvoiceSchema = z
  .object(invoiceBody)
  .strict()
  .refine(datesOrdered, { path: ['dueDate'], error: 'Due date cannot be before the issue date' });
export type UpdateInvoiceInput = z.input<typeof updateInvoiceSchema>;

export const issueInvoiceSchema = z
  .object({ issueDate: isoDate.optional(), dueDate: isoDate.optional() })
  .strict()
  .refine(datesOrdered, { path: ['dueDate'], error: 'Due date cannot be before the issue date' });

export const reasonSchema = z
  .object({ reason: z.string().trim().min(3, { error: 'Give a reason' }).max(1000) })
  .strict();

export const creditNoteSchema = z
  .object({
    amount: positiveMoneySchema,
    reason: z.string().trim().min(3, { error: 'Give a reason' }).max(1000),
    issueDate: isoDate.optional(),
  })
  .strict();

export const listInvoicesSchema = z.object({
  status: z
    .enum(['all', 'open', 'draft', 'unpaid', 'partial', 'paid', 'overdue', 'void', 'written_off'])
    .default('all'),
  clientId: uuidSchema.optional(),
  matterId: uuidSchema.optional(),
  search: z.string().trim().max(100).optional(),
  dueFrom: isoDate.optional(),
  dueTo: isoDate.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const allocationSchema = z.object({ invoiceId: uuidSchema, amount: positiveMoneySchema }).strict();

export const recordPaymentSchema = z
  .object({
    clientId: uuidSchema,
    matterId: uuidSchema.nullable().optional(),
    amount: moneySchema,
    tdsAmount: moneySchema.default('0'),
    paymentDate: isoDate,
    method: z.enum(PAYMENT_METHODS),
    referenceNumber: nullableText(255),
    notes: nullableText(2000),
    allocations: z.array(allocationSchema).max(50).default([]),
    /** Explicit opt-in: anything not allocated becomes a client advance (PRD Screen 18). */
    keepRemainderAsAdvance: z.boolean().default(false),
  })
  .strict()
  .refine((v) => Number(v.amount) + Number(v.tdsAmount) > 0, {
    path: ['amount'],
    error: 'Enter the amount received',
  })
  .refine((v) => new Set(v.allocations.map((a) => a.invoiceId)).size === v.allocations.length, {
    path: ['allocations'],
    error: 'Each invoice can appear once',
  });
export type RecordPaymentInput = z.input<typeof recordPaymentSchema>;

export const tdsCertificateSchema = z
  .object({ certificateNumber: z.string().trim().min(1).max(100), receivedOn: isoDate })
  .strict();

export const listPaymentsSchema = z.object({
  clientId: uuidSchema.optional(),
  matterId: uuidSchema.optional(),
  from: isoDate.optional(),
  until: isoDate.optional(),
  status: z.enum(['posted', 'reversed', 'all']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const expenseSchema = z
  .object({
    matterId: uuidSchema,
    caseId: uuidSchema.nullable().optional(),
    category: nullableText(100),
    amount: positiveMoneySchema,
    expenseDate: isoDate,
    description: nullableText(2000),
    vendorName: nullableText(255),
    billableToClient: z.boolean().default(true),
    reimbursable: z.boolean().default(true),
  })
  .strict();
export type ExpenseInput = z.input<typeof expenseSchema>;

export const updateExpenseSchema = z
  .object({
    category: nullableText(100),
    amount: positiveMoneySchema.optional(),
    expenseDate: isoDate.optional(),
    description: nullableText(2000),
    vendorName: nullableText(255),
    billableToClient: z.boolean().optional(),
    reimbursable: z.boolean().optional(),
  })
  .strict();

export const listExpensesSchema = z.object({
  matterId: uuidSchema.optional(),
  status: z.enum(['recorded', 'billed', 'void', 'unbilled', 'all']).default('all'),
});

const milestoneFields = {
  name: z.string().trim().min(1, { error: 'Name the milestone' }).max(255),
  amount: moneySchema,
  dueDate: nullableDate,
};
export const milestoneSchema = z.object(milestoneFields).strict();

export const feeAgreementSchema = z
  .object({
    matterId: uuidSchema,
    agreementType: z.enum(FEE_AGREEMENT_TYPES),
    description: nullableText(2000),
    agreedAmount: moneySchema.nullable().optional(),
    perAppearanceAmount: moneySchema.nullable().optional(),
    taxIncluded: z.boolean().default(false),
    effectiveDate: nullableDate,
    notes: nullableText(5000),
    milestones: z.array(milestoneSchema).max(50).default([]),
  })
  .strict();
export type FeeAgreementInput = z.input<typeof feeAgreementSchema>;

export const updateFeeAgreementSchema = z
  .object({
    agreementType: z.enum(FEE_AGREEMENT_TYPES).optional(),
    description: nullableText(2000),
    agreedAmount: moneySchema.nullable().optional(),
    perAppearanceAmount: moneySchema.nullable().optional(),
    taxIncluded: z.boolean().optional(),
    effectiveDate: nullableDate,
    notes: nullableText(5000),
    status: z.enum(['draft', 'active', 'completed', 'cancelled']).optional(),
  })
  .strict();

export const updateMilestoneSchema = z
  .object({
    name: milestoneFields.name.optional(),
    amount: moneySchema.optional(),
    dueDate: nullableDate,
    status: z.enum(['planned', 'waived', 'cancelled']).optional(),
  })
  .strict();
