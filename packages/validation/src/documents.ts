import { DOCUMENT_CATEGORIES, DOCUMENT_TYPES, documentExtension, MAX_DOCUMENT_BYTES } from '@legalops/types';
import { z } from 'zod';
import { uuidSchema } from './common.js';

const allowed = Object.keys(DOCUMENT_TYPES).join(', ');

export const startDocumentUploadSchema = z
  .object({
    matterId: uuidSchema,
    caseId: uuidSchema.nullable().optional(),
    hearingId: uuidSchema.nullable().optional(),
    category: z.enum(DOCUMENT_CATEGORIES).default('other'),
    name: z
      .string()
      .trim()
      .min(1, { error: 'The file needs a name' })
      .max(255, { error: 'File names can be up to 255 characters' })
      .refine((n) => documentExtension(n) in DOCUMENT_TYPES, { error: `This file type isn’t allowed. Allowed: ${allowed}` }),
    sizeBytes: z
      .number()
      .int()
      .min(1, { error: 'The file is empty' })
      .max(MAX_DOCUMENT_BYTES, { error: 'Files can be up to 500 MB' }),
  })
  .strict();

export const completeDocumentUploadSchema = z
  .object({
    parts: z
      .array(z.object({ partNumber: z.number().int().min(1).max(10000), etag: z.string().min(1).max(200) }).strict())
      .min(1)
      .max(10000),
  })
  .strict();

export const listDocumentsSchema = z
  .object({
    matterId: uuidSchema.optional(),
    hearingId: uuidSchema.optional(),
    caseId: uuidSchema.optional(),
    category: z.enum(DOCUMENT_CATEGORIES).optional(),
    search: z.string().trim().max(200).optional(),
    includeDeleted: z.coerce.boolean().default(false),
  })
  .refine((v) => v.matterId || v.hearingId, { error: 'Give a matter or a hearing' });

export const downloadDocumentSchema = z.object({ inline: z.enum(['1', '0', 'true', 'false']).optional() });
