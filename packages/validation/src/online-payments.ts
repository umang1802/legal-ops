import { z } from 'zod';
import { positiveMoneySchema } from './billing.js';

const secret = (label: string) =>
  z
    .string()
    .trim()
    .min(8, { error: `${label} looks too short` })
    .max(2000);

/**
 * Saving the Zoho Pay settings for a firm. Secrets are optional on an update: leaving one out keeps the stored
 * value. On first save the client secret and refresh token are required (the service enforces that).
 */
export const zohoPayConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    environment: z.enum(['sandbox', 'live']).optional(),
    accountId: z
      .string()
      .trim()
      .regex(/^[0-9]{3,20}$/, { error: 'The Zoho Payments account ID is a number' })
      .optional(),
    clientId: z.string().trim().min(5, { error: 'Enter the OAuth client ID' }).max(120).optional(),
    clientSecret: secret('The client secret').optional(),
    refreshToken: secret('The refresh token').optional(),
    signingKey: secret('The signing key').optional(),
  })
  .strict();
export type ZohoPayConfigInput = z.input<typeof zohoPayConfigSchema>;

export const createPaymentLinkSchema = z
  .object({
    /** Defaults to the full amount due. */
    amount: positiveMoneySchema.optional(),
    expiresInDays: z.number().int().min(1).max(60).default(7),
  })
  .strict();
export type CreatePaymentLinkInput = z.output<typeof createPaymentLinkSchema>;
