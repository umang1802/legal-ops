import { z } from 'zod';
import { emailSchema, uuidSchema } from './common.js';

export const platformLoginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(128) }).strict();
export const totpCodeSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/, { error: 'Enter the 6-digit code' }) }).strict();

export const inviteFirmSchema = z
  .object({
    firmName: z.string().trim().min(1, { error: 'Enter the firm name' }).max(200),
    partnerName: z.string().trim().min(1, { error: 'Enter the partner’s name' }).max(120),
    partnerEmail: emailSchema,
  })
  .strict();
export const reinviteFirmSchema = inviteFirmSchema.pick({ partnerName: true, partnerEmail: true }).strict();
export const firmNotesSchema = z.object({ platformNotes: z.string().max(10000).nullable() }).strict();
export const setFirmFeatureSchema = z.object({ enabled: z.boolean() }).strict();
export const suspendFirmSchema = z.object({ reason: z.string().trim().min(1, { error: 'Give a reason' }).max(500) }).strict();
export const listFirmsSchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: z.enum(['invited', 'active', 'suspended']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export const listPlatformAuditSchema = z.object({
  organizationId: uuidSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
