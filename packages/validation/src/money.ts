/**
 * Money is handled as integer paise in application code (never floats) and as NUMERIC(14,2) strings
 * at the DB/API boundary. This module is shared by the API (authoritative) and the web invoice
 * editor (live preview), so both always agree to the paisa.
 */

const MONEY_RE = /^-?\d{1,12}(\.\d{1,2})?$/;

/** '1234.5' -> 123450. Throws on more than 2 decimals or non-numeric input. */
export function toPaise(value: string | number): number {
  const s = typeof value === 'number' ? value.toFixed(2) : value.trim();
  if (!MONEY_RE.test(s)) throw new Error(`Invalid amount: ${value}`);
  const negative = s.startsWith('-');
  const [whole, frac = ''] = s.replace('-', '').split('.');
  const paise = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return negative ? -paise : paise;
}

/** 123450 -> '1234.50' */
export function fromPaise(paise: number): string {
  if (!Number.isSafeInteger(paise)) throw new Error(`Invalid paise: ${paise}`);
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Round-half-up integer division for non-negative numerators. */
function divRound(numerator: number, denominator: number): number {
  return Math.floor((numerator * 2 + denominator) / (denominator * 2));
}

/** Line amount = round_half_up(quantity × unit price), quantity in hundredths (NUMERIC(10,2)). */
export function lineAmountPaise(quantity: string | number, unitPrice: string | number): number {
  const qtyHundredths = toPaise(quantity);
  if (qtyHundredths <= 0) throw new Error('Quantity must be positive');
  return divRound(qtyHundredths * toPaise(unitPrice), 100);
}

/** GST rate '18' / '18.00' -> basis points (1800). */
export function rateBp(rate: string | number): number {
  return toPaise(rate);
}

export type TaxMode = 'simple' | 'gst';

export type InvoiceLineInput = {
  quantity: string | number;
  unitPrice: string | number;
  /** GST only; null/undefined = non-taxable line. */
  gstRate?: string | number | null | undefined;
  /** GST only: reimbursement as pure agent, outside taxable value. */
  isPureAgent?: boolean | undefined;
};

export type InvoiceCalcInput = {
  taxMode: TaxMode;
  lines: InvoiceLineInput[];
  discount: string | number;
  /** Simple mode only: tax entered as one amount. */
  simpleTax?: string | number | undefined;
  /** GST only. */
  intraState?: boolean | undefined;
  isReverseCharge?: boolean | undefined;
};

export type InvoiceTotals = {
  lineAmounts: number[];
  subtotal: number;
  discount: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  /** Disclosed GST payable by the recipient under reverse charge (not charged). */
  rcmTax: number;
  /** Tax actually charged on this invoice. */
  tax: number;
  total: number;
};

export class InvoiceCalcError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Invoice totals (PRD §30 + decisions D-001):
 *   subtotal = Σ line amounts; total = subtotal − discount + tax.
 * GST mode: the discount reduces taxable value pro-rata across taxable lines (pure-agent lines are
 * never discounted or taxed). Each rate group is taxed separately; intra-state splits into CGST+SGST
 * (each half the rate, rounded separately), inter-state is IGST. Under reverse charge nothing is
 * charged, and the would-be GST is disclosed in rcmTax.
 */
export function computeInvoiceTotals(input: InvoiceCalcInput): InvoiceTotals {
  const lineAmounts = input.lines.map((l) => lineAmountPaise(l.quantity, l.unitPrice));
  const subtotal = lineAmounts.reduce((a, b) => a + b, 0);
  const discount = toPaise(input.discount);
  if (discount < 0) throw new InvoiceCalcError('discountAmount', 'Discount cannot be negative');

  if (input.taxMode === 'simple') {
    if (discount > subtotal)
      throw new InvoiceCalcError('discountAmount', 'Discount cannot exceed the subtotal');
    const tax = toPaise(input.simpleTax ?? 0);
    if (tax < 0) throw new InvoiceCalcError('taxAmount', 'Tax cannot be negative');
    return {
      lineAmounts,
      subtotal,
      discount,
      taxableValue: subtotal - discount,
      cgst: 0,
      sgst: 0,
      igst: 0,
      rcmTax: 0,
      tax,
      total: subtotal - discount + tax,
    };
  }

  // GST: group taxable line amounts by rate.
  const groups = new Map<number, number>();
  input.lines.forEach((l, i) => {
    if (l.isPureAgent || l.gstRate === null || l.gstRate === undefined || l.gstRate === '') return;
    const bp = rateBp(l.gstRate);
    if (bp < 0 || bp > 2800)
      throw new InvoiceCalcError(`items.${i}.gstRate`, 'GST rate must be between 0 and 28%');
    groups.set(bp, (groups.get(bp) ?? 0) + lineAmounts[i]!);
  });
  const taxableGross = [...groups.values()].reduce((a, b) => a + b, 0);
  if (discount > taxableGross) {
    throw new InvoiceCalcError('discountAmount', 'Discount cannot exceed the taxable value');
  }

  // Allocate the discount pro-rata; the last group absorbs rounding so the parts sum exactly.
  const entries = [...groups.entries()].sort((a, b) => a[0] - b[0]);
  let discountLeft = discount;
  let cgst = 0;
  let sgst = 0;
  let igst = 0;
  entries.forEach(([bp, gross], idx) => {
    const share = idx === entries.length - 1 ? discountLeft : divRound(discount * gross, taxableGross || 1);
    discountLeft -= share;
    const base = gross - share;
    if (input.intraState) {
      cgst += divRound(base * bp, 20000);
      sgst += divRound(base * bp, 20000);
    } else {
      igst += divRound(base * bp, 10000);
    }
  });
  const gstTotal = cgst + sgst + igst;
  const taxableValue = taxableGross - discount;

  if (input.isReverseCharge) {
    return {
      lineAmounts,
      subtotal,
      discount,
      taxableValue,
      cgst: 0,
      sgst: 0,
      igst: 0,
      rcmTax: gstTotal,
      tax: 0,
      total: subtotal - discount,
    };
  }
  return {
    lineAmounts,
    subtotal,
    discount,
    taxableValue,
    cgst,
    sgst,
    igst,
    rcmTax: 0,
    tax: gstTotal,
    total: subtotal - discount + gstTotal,
  };
}

/** Indian financial year (April–March) for a 'YYYY-MM-DD' date: '2026-10-02' -> '2026-27'. */
export function fiscalYear(date: string): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** Aging bucket for days overdue (PRD §13): 0–7, 8–30, 31–60, 61+. */
export function agingBucket(daysOverdue: number): '0-7' | '8-30' | '31-60' | '61+' {
  if (daysOverdue <= 7) return '0-7';
  if (daysOverdue <= 30) return '8-30';
  if (daysOverdue <= 60) return '31-60';
  return '61+';
}
