import { describe, expect, it } from 'vitest';
import {
  agingBucket,
  computeInvoiceTotals,
  fiscalYear,
  fromPaise,
  lineAmountPaise,
  toPaise,
} from './money.js';

describe('paise conversion', () => {
  it('round-trips without float error', () => {
    expect(toPaise('0.1')).toBe(10);
    expect(toPaise('1234.5')).toBe(123450);
    expect(toPaise('50000')).toBe(5000000);
    expect(toPaise(0.29)).toBe(29);
    expect(fromPaise(123450)).toBe('1234.50');
    expect(fromPaise(5)).toBe('0.05');
    expect(fromPaise(-250)).toBe('-2.50');
    // 0.1 + 0.2 in floats is 0.30000000000000004; in paise it is exact.
    expect(fromPaise(toPaise('0.1') + toPaise('0.2'))).toBe('0.30');
  });

  it('rejects malformed amounts', () => {
    expect(() => toPaise('1.234')).toThrow();
    expect(() => toPaise('abc')).toThrow();
    expect(() => toPaise('1e5')).toThrow();
  });

  it('line amount rounds half up on quantity × rate', () => {
    expect(lineAmountPaise('1', '50000')).toBe(5000000);
    expect(lineAmountPaise('2.5', '3333.33')).toBe(833333); // 8333.325 -> 8333.33
    expect(lineAmountPaise('0.5', '0.05')).toBe(3); // 0.025 -> 0.03
  });
});

describe('invoice totals: simple mode', () => {
  it('total = subtotal − discount + tax', () => {
    const t = computeInvoiceTotals({
      taxMode: 'simple',
      lines: [
        { quantity: 1, unitPrice: '50000' },
        { quantity: 2, unitPrice: '2500' },
      ],
      discount: '1000',
      simpleTax: '900',
    });
    expect([t.subtotal, t.discount, t.tax, t.total].map(fromPaise)).toEqual([
      '55000.00',
      '1000.00',
      '900.00',
      '54900.00',
    ]);
  });

  it('rejects a discount larger than the subtotal', () => {
    expect(() =>
      computeInvoiceTotals({ taxMode: 'simple', lines: [{ quantity: 1, unitPrice: 100 }], discount: 101 }),
    ).toThrow(/exceed/);
  });
});

describe('invoice totals: GST', () => {
  const fees = { quantity: 1, unitPrice: '50000', gstRate: '18' };

  it('intra-state splits 9% CGST + 9% SGST', () => {
    const t = computeInvoiceTotals({ taxMode: 'gst', lines: [fees], discount: 0, intraState: true });
    expect([t.cgst, t.sgst, t.igst, t.tax, t.total].map(fromPaise)).toEqual([
      '4500.00',
      '4500.00',
      '0.00',
      '9000.00',
      '59000.00',
    ]);
  });

  it('inter-state charges 18% IGST', () => {
    const t = computeInvoiceTotals({ taxMode: 'gst', lines: [fees], discount: 0, intraState: false });
    expect([t.cgst, t.igst, t.total].map(fromPaise)).toEqual(['0.00', '9000.00', '59000.00']);
  });

  it('reverse charge: nothing charged, GST disclosed', () => {
    const t = computeInvoiceTotals({
      taxMode: 'gst',
      lines: [fees],
      discount: 0,
      intraState: true,
      isReverseCharge: true,
    });
    expect([t.tax, t.rcmTax, t.total].map(fromPaise)).toEqual(['0.00', '9000.00', '50000.00']);
    expect(t.cgst + t.sgst + t.igst).toBe(0);
  });

  it('pure-agent reimbursements (court fees) are neither taxed nor discounted', () => {
    const t = computeInvoiceTotals({
      taxMode: 'gst',
      lines: [fees, { quantity: 1, unitPrice: '1500', isPureAgent: true }],
      discount: '5000',
      intraState: false,
    });
    expect(fromPaise(t.taxableValue)).toBe('45000.00');
    expect(fromPaise(t.igst)).toBe('8100.00');
    expect(fromPaise(t.total)).toBe('54600.00'); // 51500 − 5000 + 8100
  });

  it('discount is allocated pro-rata across rate groups and sums exactly', () => {
    const t = computeInvoiceTotals({
      taxMode: 'gst',
      lines: [
        { quantity: 1, unitPrice: '10000', gstRate: 18 },
        { quantity: 1, unitPrice: '3333.33', gstRate: 5 },
      ],
      discount: '1000',
      intraState: false,
    });
    // 18% on 10000 − 750.00 = 9250 -> 1665.00; 5% on 3333.33 − 250.00 = 3083.33 -> 154.17
    expect(fromPaise(t.igst)).toBe('1819.17');
    expect(fromPaise(t.total)).toBe(fromPaise(1333333 - 100000 + 181917));
  });

  it('CGST and SGST round separately; tax is their exact sum', () => {
    const t = computeInvoiceTotals({
      taxMode: 'gst',
      lines: [{ quantity: 1, unitPrice: '10.01', gstRate: 18 }],
      discount: 0,
      intraState: true,
    });
    // 9% of 10.01 = 0.9009 -> 0.90 each
    expect([t.cgst, t.sgst, t.tax].map(fromPaise)).toEqual(['0.90', '0.90', '1.80']);
  });

  it('rejects out-of-range GST rates', () => {
    expect(() =>
      computeInvoiceTotals({
        taxMode: 'gst',
        lines: [{ quantity: 1, unitPrice: 1, gstRate: 30 }],
        discount: 0,
      }),
    ).toThrow(/28/);
  });
});

describe('fiscal year and aging', () => {
  it('uses the Indian April–March year', () => {
    expect(fiscalYear('2026-10-02')).toBe('2026-27');
    expect(fiscalYear('2027-03-31')).toBe('2026-27');
    expect(fiscalYear('2027-04-01')).toBe('2027-28');
    expect(fiscalYear('2099-06-01')).toBe('2099-00');
  });
  it('buckets days overdue', () => {
    expect([0, 7, 8, 30, 31, 60, 61, 400].map(agingBucket)).toEqual([
      '0-7',
      '0-7',
      '8-30',
      '8-30',
      '31-60',
      '31-60',
      '61+',
      '61+',
    ]);
  });
});
