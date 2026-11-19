import { z } from 'zod';
import { uuidSchema } from './common.js';

const name = z
  .string()
  .trim()
  .min(1, { error: 'Enter a name' })
  .max(100, { error: 'Keep it under 100 characters' });

export const createHearingTypeSchema = z.object({ name }).strict();
export const updateHearingTypeSchema = z
  .object({ name: name.optional(), isActive: z.boolean().optional() })
  .strict()
  .refine((v) => v.name !== undefined || v.isActive !== undefined, { error: 'Nothing to change' });
/** The full list in its new order. */
export const reorderHearingTypesSchema = z.object({ ids: z.array(uuidSchema).min(1).max(200) }).strict();
