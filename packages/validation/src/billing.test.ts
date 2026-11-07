import { describe, expect, it } from 'vitest';
import { createClientSchema, createInvoiceSchema, updateOrganizationSchema } from './index.js';

const base = {
  matterId: '11111111-1111-4111-8111-111111111111',
  items: [{ description: 'Fee', unitPrice: '1000' }],
};

describe('instalments', () => {
  it('instalments must have increasing due dates', () => {
    const r = createInvoiceSchema.safeParse({
      ...base,
      instalments: [
        { amount: '500', dueDate: '2026-12-01' },
        { amount: '500', dueDate: '2026-11-01' },
      ],
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path.join('.') === 'instalments.1.dueDate')).toBe(true);
  });
  it('accepts increasing dates', () => {
    expect(
      createInvoiceSchema.safeParse({
        ...base,
        instalments: [
          { amount: '500', dueDate: '2026-11-01' },
          { amount: '500', dueDate: '2026-12-01' },
        ],
      }).success,
    ).toBe(true);
  });
  it('rejects 1 instalment', () => {
    expect(
      createInvoiceSchema.safeParse({ ...base, instalments: [{ amount: '1000', dueDate: '2026-11-01' }] }).success,
    ).toBe(false);
  });
  it('rejects 25 instalments', () => {
    const instalments = Array.from({ length: 25 }, (_, i) => ({
      amount: '10',
      dueDate: `2027-${String((i % 12) + 1).padStart(2, '0')}-01`,
    }));
    expect(createInvoiceSchema.safeParse({ ...base, instalments }).success).toBe(false);
  });
});

describe('firm settings', () => {
  it('IFSC lowercase is normalised and accepted', () => {
    expect(updateOrganizationSchema.parse({ bankIfsc: 'hdfc0001234' }).bankIfsc).toBe('HDFC0001234');
  });
  it('IFSC with wrong 5th char rejected', () => {
    expect(updateOrganizationSchema.safeParse({ bankIfsc: 'HDFC1001234' }).success).toBe(false);
  });
  it('invoiceNumberDigits 2 and 9 rejected', () => {
    expect(updateOrganizationSchema.safeParse({ invoiceNumberDigits: 2 }).success).toBe(false);
    expect(updateOrganizationSchema.safeParse({ invoiceNumberDigits: 9 }).success).toBe(false);
    expect(updateOrganizationSchema.safeParse({ invoiceNumberDigits: 6 }).success).toBe(true);
  });
  it('account number is 6-18 digits', () => {
    expect(updateOrganizationSchema.safeParse({ bankAccountNumber: '12345' }).success).toBe(false);
    expect(updateOrganizationSchema.safeParse({ bankAccountNumber: '123456789012' }).success).toBe(true);
  });
});

describe('client cc', () => {
  it('ccEmails max 5', () => {
    const emails = (n: number) => Array.from({ length: n }, (_, i) => `a${i}@example.com`);
    expect(createClientSchema.safeParse({ name: 'X', ccEmails: emails(5) }).success).toBe(true);
    expect(createClientSchema.safeParse({ name: 'X', ccEmails: emails(6) }).success).toBe(false);
  });
});
