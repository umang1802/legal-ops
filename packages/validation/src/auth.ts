import { z } from 'zod';
import { emailSchema, passwordSchema, tokenSchema, uuidSchema } from './common.js';

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, { error: 'Enter your password' }).max(128),
  remember: z.boolean().optional().default(false),
});
export type LoginInput = z.input<typeof loginSchema>;

export const forgotPasswordSchema = z.object({ email: emailSchema });
export type ForgotPasswordInput = z.input<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({ token: tokenSchema, password: passwordSchema });
export type ResetPasswordInput = z.input<typeof resetPasswordSchema>;

export const verifyEmailSchema = z.object({ token: tokenSchema });

export const acceptInvitationSchema = z.object({
  token: tokenSchema,
  firstName: z.string().trim().min(1, { error: 'Enter your first name' }).max(100),
  lastName: z.string().trim().max(100).optional(),
  password: passwordSchema,
});
export type AcceptInvitationInput = z.input<typeof acceptInvitationSchema>;

export const switchOrganizationSchema = z.object({ organizationId: uuidSchema });
