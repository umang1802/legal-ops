import { describe, expect, it } from 'vitest';
import { loginSchema, resetPasswordSchema, updateOrganizationSchema } from './index.js';

describe('validation', () => {
  it('normalises login email', () => {
    expect(loginSchema.parse({ email: '  Partner@Example.com ', password: 'x' }).email).toBe(
      'partner@example.com',
    );
  });

  it('rejects short passwords on reset', () => {
    expect(resetPasswordSchema.safeParse({ token: 'a'.repeat(43), password: 'short' }).success).toBe(false);
  });

  it('validates GSTIN format and upper-cases it', () => {
    expect(updateOrganizationSchema.parse({ gstin: '07aaaca1234a1z5' }).gstin).toBe('07AAACA1234A1Z5');
    expect(updateOrganizationSchema.safeParse({ gstin: 'NOTAGSTIN' }).success).toBe(false);
  });

  it('rejects unknown organization fields (no organizationId smuggling)', () => {
    expect(updateOrganizationSchema.safeParse({ id: 'x' }).success).toBe(false);
  });
});
