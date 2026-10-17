import { describe, expect, it } from 'vitest';
import { createClientSchema, createMatterSchema, normalizePhone, updateClientSchema } from './index.js';

describe('normalizePhone', () => {
  it.each([
    ['9876543210', '+919876543210'],
    ['09876543210', '+919876543210'],
    ['919876543210', '+919876543210'],
    ['+91 98765-43210', '+919876543210'],
    ['+1 (415) 555-0100', '+14155550100'],
  ])('%s -> %s', (raw, expected) => expect(normalizePhone(raw)).toBe(expected));

  it('rejects non-numbers', () => {
    expect(normalizePhone('abc')).toBeNull();
    expect(normalizePhone('12345')).toBeNull();
  });
});

describe('client schemas', () => {
  it('turns empty strings into null and validates contact fields', () => {
    const parsed = createClientSchema.parse({ name: ' Raj Sharma ', email: '', phone: '98765 43210' });
    expect(parsed).toMatchObject({
      name: 'Raj Sharma',
      email: null,
      phone: '98765 43210',
      clientType: 'person',
    });
    expect(createClientSchema.safeParse({ name: 'X', phone: '12' }).success).toBe(false);
    expect(createClientSchema.safeParse({ name: 'X', gstin: 'bad' }).success).toBe(false);
  });

  it('update leaves omitted fields undefined (untouched) but allows explicit clearing', () => {
    const parsed = updateClientSchema.parse({ email: null });
    expect(parsed.email).toBeNull();
    expect('phone' in parsed ? parsed.phone : undefined).toBeUndefined();
  });

  it('rejects unknown keys such as organizationId', () => {
    expect(createClientSchema.safeParse({ name: 'X', organizationId: 'x' }).success).toBe(false);
  });
});

describe('matter schema', () => {
  it('validates CNR format on the nested first case', () => {
    const base = { clientId: '7f1c6a52-6a4c-4c2e-9d55-8d3f1f5b0a11', title: 'Sharma v ABC' };
    expect(
      createMatterSchema.safeParse({ ...base, initialCase: { title: 'CS 1/2026', cnr: 'dlhc010012342026' } })
        .data?.initialCase?.cnr,
    ).toBe('DLHC010012342026');
    expect(createMatterSchema.safeParse({ ...base, initialCase: { title: 'x', cnr: 'short' } }).success).toBe(
      false,
    );
  });
});
