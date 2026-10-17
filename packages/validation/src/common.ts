import { z } from 'zod';

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(320)
  .pipe(z.email({ error: 'Enter a valid email address' }));

export const passwordSchema = z
  .string()
  .min(10, { error: 'Use at least 10 characters' })
  .max(128, { error: 'Use at most 128 characters' });

export const uuidSchema = z.uuid({ error: 'Invalid id' });

/** Opaque URL tokens (magic links, reset, invites): base64url, 43 chars for 32 bytes. */
export const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/, { error: 'Invalid or expired link' });

export const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export const gstinSchema = z.string().trim().toUpperCase().regex(GSTIN_REGEX, { error: 'Invalid GSTIN' });
export const panSchema = z.string().trim().toUpperCase().regex(PAN_REGEX, { error: 'Invalid PAN' });
export const stateCodeSchema = z.string().regex(/^\d{2}$/, { error: 'Use the 2-digit GST state code' });

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(200).optional(),
});
