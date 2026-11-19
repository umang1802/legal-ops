import { METADATA_LIST_KEYS } from '@legalops/types';
import { z } from 'zod';
import { uuidSchema } from './common.js';

export const metadataListSchema = z.enum(METADATA_LIST_KEYS);

const name = z
  .string()
  .trim()
  .min(1, { error: 'Enter a name' })
  .max(100, { error: 'Keep it under 100 characters' });

export const createMetadataOptionSchema = z.object({ name }).strict();
export const updateMetadataOptionSchema = z
  .object({ name: name.optional(), isActive: z.boolean().optional() })
  .strict()
  .refine((v) => v.name !== undefined || v.isActive !== undefined, { error: 'Nothing to change' });
/** The full list in its new order. */
export const reorderMetadataOptionsSchema = z.object({ ids: z.array(uuidSchema).min(1).max(300) }).strict();
