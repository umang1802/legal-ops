import { CASE_STATUSES, MATTER_STAFF_ROLES, MATTER_STATUSES, PARTY_SIDES, PRIORITIES } from '@legalops/types';
import { z } from 'zod';
import { uuidSchema } from './common.js';
import { nullableDate, nullableEmail, nullablePhone, nullableText, tagsSchema } from './fields.js';

const cnrSchema = z
  .string()
  .trim()
  .toUpperCase()
  .nullable()
  .optional()
  .transform((v) => (v === '' ? null : v))
  .refine((v) => v == null || /^[A-Z0-9]{16}$/.test(v), {
    error: 'CNR is 16 letters/digits, e.g. DLHC010012342023',
  });

const caseFields = {
  title: z.string().trim().min(1, { error: 'Enter the case title' }).max(255),
  caseNumber: nullableText(150),
  cnr: cnrSchema,
  courtId: uuidSchema.nullable().optional(),
  caseType: nullableText(100),
  filingDate: nullableDate,
  registrationDate: nullableDate,
  status: z.enum(CASE_STATUSES).default('active'),
  judgeBench: nullableText(255),
};

/** A case nested in "create matter" (Journey A). */
export const initialCaseSchema = z.object(caseFields).strict();

export const createCaseSchema = z.object({ matterId: uuidSchema, ...caseFields }).strict();
export type CreateCaseInput = z.input<typeof createCaseSchema>;

export const updateCaseSchema = z
  .object({
    title: caseFields.title.optional(),
    caseNumber: caseFields.caseNumber,
    cnr: caseFields.cnr,
    courtId: caseFields.courtId,
    caseType: caseFields.caseType,
    filingDate: caseFields.filingDate,
    registrationDate: caseFields.registrationDate,
    status: z.enum(CASE_STATUSES).optional(),
    judgeBench: caseFields.judgeBench,
  })
  .strict();
export type UpdateCaseInput = z.input<typeof updateCaseSchema>;

export const createMatterSchema = z
  .object({
    clientId: uuidSchema,
    title: z.string().trim().min(1, { error: 'Enter the matter title' }).max(255),
    referenceCode: nullableText(100),
    practiceArea: nullableText(100),
    status: z.enum(MATTER_STATUSES).default('active'),
    priority: z.enum(PRIORITIES).default('normal'),
    startDate: nullableDate,
    internalNotes: nullableText(10000),
    clientSummary: nullableText(5000),
    tags: tagsSchema,
    leadUserId: uuidSchema.nullable().optional(),
    staffUserIds: z.array(uuidSchema).max(20).default([]),
    initialCase: initialCaseSchema.nullable().optional(),
  })
  .strict();
export type CreateMatterInput = z.input<typeof createMatterSchema>;

export const updateMatterSchema = z
  .object({
    title: z.string().trim().min(1).max(255).optional(),
    referenceCode: nullableText(100),
    practiceArea: nullableText(100),
    status: z.enum(MATTER_STATUSES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    startDate: nullableDate,
    closeDate: nullableDate,
    internalNotes: nullableText(10000),
    clientSummary: nullableText(5000),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  })
  .strict();
export type UpdateMatterInput = z.input<typeof updateMatterSchema>;

export const addMatterStaffSchema = z
  .object({ userId: uuidSchema, role: z.enum(MATTER_STAFF_ROLES).default('support') })
  .strict();

export const listMattersSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(200).optional(),
  status: z.enum([...MATTER_STATUSES, 'open', 'all']).default('open'),
  priority: z.enum(PRIORITIES).optional(),
  practiceArea: z.string().trim().max(100).optional(),
  lawyerId: uuidSchema.optional(),
  clientId: uuidSchema.optional(),
});

export const partySchema = z
  .object({
    name: z.string().trim().min(1, { error: 'Enter the party name' }).max(255),
    partyType: nullableText(100),
    side: z.enum(PARTY_SIDES).nullable().optional(),
    isClient: z.boolean().default(false),
    email: nullableEmail,
    phone: nullablePhone,
  })
  .strict();
export type PartyInput = z.input<typeof partySchema>;

export const advocateSchema = z
  .object({
    name: z.string().trim().min(1, { error: 'Enter the advocate name' }).max(255),
    firmName: nullableText(255),
    enrollmentNumber: nullableText(100),
    phone: nullablePhone,
    email: nullableEmail,
    isInternal: z.boolean().default(false),
    side: z.enum(PARTY_SIDES).nullable().optional(),
    isLead: z.boolean().default(false),
  })
  .strict();
export type AdvocateInput = z.input<typeof advocateSchema>;

export const createCourtSchema = z
  .object({
    name: z.string().trim().min(2, { error: 'Enter the court name' }).max(255),
    courtType: nullableText(100),
    city: nullableText(120),
    state: nullableText(120),
  })
  .strict();
export type CreateCourtInput = z.input<typeof createCourtSchema>;

export const searchSchema = z.object({ q: z.string().trim().min(2).max(100) });
