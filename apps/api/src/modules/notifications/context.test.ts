import { describe, expect, it } from 'vitest';
import { clientGreeting, paymentTerms } from './context.js';

describe('clientGreeting', () => {
  it('uses the contact person alone, without the salutation', () => {
    expect(clientGreeting({ salutation: 'M/s', contactPerson: ' Priya Nair ', name: 'Acme Pvt Ltd' })).toBe('Dear Priya Nair');
  });
  it('falls back to salutation + name for individuals', () => {
    expect(clientGreeting({ salutation: 'Mr', contactPerson: null, name: 'Rohan Mehta' })).toBe('Dear Mr Rohan Mehta');
    expect(clientGreeting({ salutation: 'M/s', contactPerson: '   ', name: 'Acme Pvt Ltd' })).toBe('Dear M/s Acme Pvt Ltd');
  });
  it('omits a missing salutation cleanly', () => {
    expect(clientGreeting({ salutation: null, contactPerson: null, name: 'Rohan Mehta' })).toBe('Dear Rohan Mehta');
  });
});

describe('paymentTerms without a due date (K1)', () => {
  it('omits the "Due by" line and reads "due on receipt"', () => {
    const t = paymentTerms([], '₹5,000.00', '');
    expect(t.due_now).toBe('on receipt');
    expect(t.amount_now).toBe('₹5,000.00');
    expect(t.payment_terms_html).not.toContain('Due by');
    expect(t.payment_terms_html).toContain('₹5,000.00');
    expect(`Invoice X from F: ${t.amount_now} due ${t.due_now}`).toBe('Invoice X from F: ₹5,000.00 due on receipt');
  });
  it('keeps "Due by" when there is a date', () => {
    const t = paymentTerms([], '₹5,000.00', '20 Nov 2026');
    expect(t.due_now).toBe('20 Nov 2026');
    expect(t.payment_terms_html).toContain('Due by: <strong>20 Nov 2026</strong>');
  });
});
