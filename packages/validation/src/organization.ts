import { z } from 'zod';
import { emailSchema, gstinSchema, panSchema, pincodeSchema, stateCodeSchema } from './common.js';

const ASSIGNABLE_ROLES = ['owner', 'admin', 'lawyer', 'staff', 'finance', 'read_only'] as const;

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
  })
  .strict()
  .refine((v) => v.role !== undefined || v.status !== undefined, { error: 'Nothing to update' });
export type UpdateMemberInput = z.input<typeof updateMemberSchema>;
