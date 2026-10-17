import { z } from 'zod';
import { GSTIN_REGEX, PAN_REGEX } from './common.js';

/** Optional text that the client may clear: '' and null both mean "no value" (stored as NULL). */
export const nullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === '' ? null : v));

export const nullableEmail = z
  .string()
  .trim()
  .toLowerCase()
  .max(320)
  .nullable()
  .optional()
  .transform((v) => (v === '' ? null : v))
  .pipe(z.email({ error: 'Enter a valid email address' }).nullable().optional());

export const nullablePhone = z
  .string()
  .trim()
  .max(40)
  .nullable()
  .optional()
  .transform((v) => (v === '' ? null : v))
  .refine((v) => v == null || normalizePhone(v) !== null, { error: 'Enter a valid phone number' });

export const nullableGstin = z
  .string()
  .trim()
  .toUpperCase()
  .nullable()
  .optional()
  .transform((v) => (v === '' ? null : v))
  .refine((v) => v == null || GSTIN_REGEX.test(v), { error: 'Invalid GSTIN' });

export const nullablePan = z
  .string()
  .trim()
  .toUpperCase()
  .nullable()
  .optional()
  .transform((v) => (v === '' ? null : v))
  .refine((v) => v == null || PAN_REGEX.test(v), { error: 'Invalid PAN' });

export const nullableStateCode = z
  .string()
  .trim()
  .nullable()
  .optional()
  .transform((v) => (v === '' ? null : v))
  .refine((v) => v == null || /^\d{2}$/.test(v), { error: 'Use the 2-digit GST state code' });

export const nullableDate = z
  .string()
  .nullable()
  .optional()
  .transform((v) => (v === '' ? null : v))
  .pipe(z.iso.date({ error: 'Use a valid date' }).nullable().optional());

export const tagsSchema = z.array(z.string().trim().min(1).max(40)).max(20).default([]);

/**
 * Normalises Indian-style numbers to E.164 for matching. Returns null when it can't be a phone number.
 * 9876543210, 09876543210, 919876543210, +91 98765-43210 -> +919876543210. Other "+CC..." kept as-is.
 */
export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `+91${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  return null;
}
