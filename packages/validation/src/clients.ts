import { CLIENT_TYPES } from '@legalops/types';
import { z } from 'zod';
import {
  nullableEmail,
  nullableGstin,
  nullablePan,
  nullablePhone,
  nullableStateCode,
  nullableText,
  tagsSchema,
} from './fields.js';

const clientFields = {
  clientType: z.enum(CLIENT_TYPES).default('person'),
  name: z.string().trim().min(1, { error: 'Enter the client name' }).max(255),
  email: nullableEmail,
  phone: nullablePhone,
  alternatePhone: nullablePhone,
  address: nullableText(2000),
  city: nullableText(120),
  state: nullableText(120),
  stateCode: nullableStateCode,
  gstin: nullableGstin,
  pan: nullablePan,
  notes: nullableText(5000),
  tags: tagsSchema,
  emailNotificationsEnabled: z.boolean().default(true),
};

export const createClientSchema = z
  .object({
    ...clientFields,
    /** Set after the user has seen the duplicate warning and chosen to create anyway. Never auto-merged. */
    acknowledgeDuplicates: z.boolean().default(false),
  })
  .strict();
export type CreateClientInput = z.input<typeof createClientSchema>;

export const updateClientSchema = z
  .object({
    clientType: clientFields.clientType.optional(),
    name: clientFields.name.optional(),
    email: clientFields.email,
    phone: clientFields.phone,
    alternatePhone: clientFields.alternatePhone,
    address: clientFields.address,
    city: clientFields.city,
    state: clientFields.state,
    stateCode: clientFields.stateCode,
    gstin: clientFields.gstin,
    pan: clientFields.pan,
    notes: clientFields.notes,
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    emailNotificationsEnabled: z.boolean().optional(),
    status: z.enum(['active', 'inactive']).optional(),
  })
  .strict();
export type UpdateClientInput = z.input<typeof updateClientSchema>;

export const listClientsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(200).optional(),
  status: z.enum(['active', 'inactive', 'archived', 'all']).default('active'),
});
