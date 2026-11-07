import { LOGO_TYPES, type LogoContentType, MAX_LOGO_BYTES, MAX_SIGNATURE_BYTES } from '@legalops/types';
import { z } from 'zod';
import { emailSchema, gstinSchema, panSchema, pincodeSchema, stateCodeSchema } from './common.js';

const ASSIGNABLE_ROLES = ['owner', 'admin', 'lawyer', 'staff', 'finance', 'read_only'] as const;

/** Optional text the client may clear: '' becomes null. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === '' ? null : v));

const nullable = <T extends z.ZodType>(schema: T) => schema.nullable().optional();

export const updateOrganizationSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    legalName: nullable(z.string().trim().max(255)),
    email: nullable(emailSchema),
    phone: nullable(z.string().trim().max(40)),
    address: nullable(z.string().trim().max(2000)),
    city: nullable(z.string().trim().max(120)),
    state: nullable(z.string().trim().max(120)),
    pincode: nullable(pincodeSchema),
    stateCode: nullable(stateCodeSchema),
    timezone: z.string().trim().min(1).max(64).optional(),
    remindersEnabled: z.boolean().optional(),
    calendarHideParties: z.boolean().optional(),
    invoicePrefix: z
      .string()
      .trim()
      .regex(/^[A-Z0-9-]{1,20}$/, { error: 'Use 1–20 capital letters, digits or hyphens' })
      .optional(),
    taxMode: z.enum(['simple', 'gst']).optional(),
    gstin: nullable(gstinSchema),
    pan: nullable(panSchema),
    defaultSendTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: 'Use HH:MM (24h)' })
      .optional(),
    registrationLabel: optionalText(30),
    registrationValue: optionalText(60),
    bankAccountName: optionalText(255),
    bankAccountNumber: z
      .string()
      .trim()
      .nullable()
      .optional()
      .transform((v) => (v === '' ? null : v))
      .refine((v) => v == null || /^\d{6,18}$/.test(v), { error: 'Account number is 6–18 digits' }),
    bankIfsc: z
      .string()
      .trim()
      .toUpperCase()
      .nullable()
      .optional()
      .transform((v) => (v === '' ? null : v))
      .refine((v) => v == null || /^[A-Z]{4}0[A-Z0-9]{6}$/.test(v), { error: 'Invalid IFSC code' }),
    bankName: optionalText(120),
    bankBranch: optionalText(120),
    upiId: optionalText(120),
    invoiceNumberDigits: z.number().int().min(3).max(8).optional(),
  })
  .strict();
export type UpdateOrganizationInput = z.input<typeof updateOrganizationSchema>;

export const inviteMemberSchema = z.object({
  email: emailSchema,
  role: z.enum(ASSIGNABLE_ROLES),
});
export type InviteMemberInput = z.input<typeof inviteMemberSchema>;

export const updateMemberSchema = z
  .object({
    role: z.enum(ASSIGNABLE_ROLES).optional(),
    status: z.enum(['active', 'suspended']).optional(),
    designation: z.string().trim().min(1, { error: 'Enter a designation' }).max(120, { error: 'Designation can be up to 120 characters' }).optional(),
  })
  .strict()
  .refine((v) => v.role !== undefined || v.status !== undefined || v.designation !== undefined, { error: 'Nothing to update' });
export type UpdateMemberInput = z.input<typeof updateMemberSchema>;

const LOGO_CONTENT_TYPES = Object.keys(LOGO_TYPES) as [LogoContentType, ...LogoContentType[]];
export const startLogoUploadSchema = z
  .object({
    contentType: z.enum(LOGO_CONTENT_TYPES, { error: 'That file isn’t a PNG or JPG' }),
    sizeBytes: z.number().int().min(1).max(MAX_LOGO_BYTES, { error: 'Logos can be up to 1 MB' }),
  })
  .strict();
/** The server reads the file's real type from its bytes, so completing needs nothing from the browser. */
export const completeLogoUploadSchema = z.object({}).strict();

export const startSignatureUploadSchema = z
  .object({
    contentType: z.enum(LOGO_CONTENT_TYPES, { error: 'That file isn’t a PNG or JPG' }),
    sizeBytes: z.number().int().min(1).max(MAX_SIGNATURE_BYTES, { error: 'Signature images can be up to 500 KB' }),
  })
  .strict();
