import { z } from 'zod';

/**
 * A firm's invoice look: which sections show and in what order, the letterhead, labels, footer, signature position and
 * the watermark. Stored as JSON on the firm and fully defaulted, so a firm that never opens the settings page gets the
 * standard format, and a partly-saved or older value is always completed rather than rejected.
 */

/** Sections between the title and the footer, in the default top-to-bottom order. */
export const INVOICE_SECTION_IDS = [
  'parties',
  'subject',
  'items',
  'schedule',
  'payment',
  'notes',
  'signature',
] as const;
export type InvoiceSectionId = (typeof INVOICE_SECTION_IDS)[number];

export const INVOICE_SECTION_LABELS: Record<InvoiceSectionId, string> = {
  parties: 'Billed to and invoice details',
  subject: 'Subject line (Re:)',
  items: 'Items and total',
  schedule: 'Payment schedule (instalments)',
  payment: 'How to pay (bank details)',
  notes: 'Notes',
  signature: 'Signature',
};

/** Sections that must always print: an invoice without its customer or its line items isn't an invoice. */
export const REQUIRED_INVOICE_SECTIONS: readonly InvoiceSectionId[] = ['parties', 'items'];

const SECTION_DEFAULT_SHOW: Record<InvoiceSectionId, boolean> = {
  parties: true,
  subject: true,
  items: true,
  schedule: true,
  payment: true,
  notes: true,
  signature: true,
};

export const INVOICE_DETAIL_IDS = [
  'number',
  'date',
  'dueDate',
  'amountDue',
  'pan',
  'gstin',
  'placeOfSupply',
  'matter',
] as const;
export type InvoiceDetailId = (typeof INVOICE_DETAIL_IDS)[number];

const DETAIL_DEFAULTS: Record<InvoiceDetailId, { label: string; show: boolean }> = {
  number: { label: 'Invoice No.', show: true },
  date: { label: 'Invoice Date', show: true },
  dueDate: { label: 'Due Date', show: false },
  amountDue: { label: 'Amount Due', show: true },
  pan: { label: 'PAN', show: true },
  gstin: { label: 'GSTIN', show: false },
  placeOfSupply: { label: 'Place of Supply', show: true },
  matter: { label: 'Matter', show: false },
};

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, { error: 'Use a colour like #2F4E7B' });
const text = (fallback: string, max: number) => z.string().trim().max(max).default(fallback);

type SectionEntry = { id: InvoiceSectionId; show: boolean };
type DetailEntry = { id: InvoiceDetailId; label: string; show: boolean };

/** Each section once, in the order given; anything missing is appended; required sections can't be hidden. */
export function normalizeSections(list: readonly SectionEntry[]): SectionEntry[] {
  const seen = new Set<InvoiceSectionId>();
  const out: SectionEntry[] = [];
  for (const s of list) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push({ id: s.id, show: REQUIRED_INVOICE_SECTIONS.includes(s.id) ? true : s.show });
  }
  for (const id of INVOICE_SECTION_IDS) if (!seen.has(id)) out.push({ id, show: SECTION_DEFAULT_SHOW[id] });
  return out;
}

export function normalizeDetails(list: readonly DetailEntry[]): DetailEntry[] {
  const seen = new Set<InvoiceDetailId>();
  const out: DetailEntry[] = [];
  for (const d of list) {
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    out.push(d);
  }
  for (const id of INVOICE_DETAIL_IDS) if (!seen.has(id)) out.push({ id, ...DETAIL_DEFAULTS[id] });
  return out;
}

const sectionList = z
  .array(z.object({ id: z.enum(INVOICE_SECTION_IDS), show: z.boolean() }))
  .max(INVOICE_SECTION_IDS.length * 2)
  .default(() => INVOICE_SECTION_IDS.map((id) => ({ id, show: SECTION_DEFAULT_SHOW[id] })))
  .transform(normalizeSections);

const detailList = z
  .array(z.object({ id: z.enum(INVOICE_DETAIL_IDS), label: z.string().trim().max(40), show: z.boolean() }))
  .max(INVOICE_DETAIL_IDS.length * 2)
  .default(() => INVOICE_DETAIL_IDS.map((id) => ({ id, ...DETAIL_DEFAULTS[id] })))
  .transform(normalizeDetails);

const position = z.enum(['top', 'center', 'bottom']);

export const invoiceFormatSchema = z.object({
  accentColor: hex.default('#2F4E7B'),
  ruleColor: hex.default('#C9AE74'),
  /** 'rs' prints "Rs. 15,000.00"; 'symbol' prints "₹15,000.00". */
  currencyStyle: z.enum(['rs', 'symbol']).default('rs'),
  letterhead: z
    .object({
      align: z.enum(['left', 'center']).default('center'),
      showLogo: z.boolean().default(true),
      logoSize: z.enum(['small', 'medium', 'large']).default('medium'),
      showName: z.boolean().default(true),
      uppercaseName: z.boolean().default(true),
      showRegistration: z.boolean().default(true),
      showAddress: z.boolean().default(true),
      addressPrefix: text('Registered Office:', 40),
      showGstin: z.boolean().default(true),
      showContact: z.boolean().default(false),
      rule: z.boolean().default(true),
    })
    .prefault({}),
  title: z
    .object({
      text: text('INVOICE', 30),
      taxText: text('TAX INVOICE', 30),
      align: z.enum(['left', 'center', 'right']).default('left'),
    })
    .prefault({}),
  sections: sectionList,
  parties: z
    .object({
      billedToLabel: text('BILLED TO', 30),
      detailsLabel: text('INVOICE DETAILS', 30),
      detailsSide: z.enum(['left', 'right']).default('right'),
      showAttention: z.boolean().default(true),
      showEmail: z.boolean().default(true),
      showPhone: z.boolean().default(true),
      showClientGstin: z.boolean().default(true),
      details: detailList,
    })
    .prefault({}),
  subject: z.object({ label: text('Re:', 20) }).prefault({}),
  items: z
    .object({
      filledHeader: z.boolean().default(true),
      showNumber: z.boolean().default(true),
      /** Quantity and rate columns. They always show when a line has a quantity other than 1, so an amount is never unexplained. */
      showQuantityRate: z.boolean().default(false),
      numberLabel: text('#', 10),
      descriptionLabel: text('DESCRIPTION', 30),
      amountLabel: text('AMOUNT', 30),
    })
    .prefault({}),
  totals: z.object({ totalLabel: text('Total', 30), accent: z.boolean().default(true) }).prefault({}),
  schedule: z.object({ title: text('PAYMENT SCHEDULE', 40) }).prefault({}),
  payment: z
    .object({
      title: text('HOW TO PAY', 40),
      intro: text('Please pay by bank transfer, quoting the invoice number:', 200),
    })
    .prefault({}),
  notes: z.object({ title: text('NOTES', 40) }).prefault({}),
  signature: z
    .object({
      align: z.enum(['left', 'center', 'right']).default('right'),
      /** {firm} becomes the firm's name. */
      onBehalfText: text('For and on behalf of {firm}', 120),
      accentName: z.boolean().default(true),
    })
    .prefault({}),
  footer: z
    .object({
      show: z.boolean().default(true),
      thankYou: text('Thank you for your business.', 120),
      showContact: z.boolean().default(true),
      website: text('', 120),
      tagline: text('', 120),
      rule: z.boolean().default(true),
      poweredBy: z.boolean().default(false),
    })
    .prefault({}),
  watermark: z
    .object({
      mode: z.enum(['none', 'logo', 'text']).default('logo'),
      text: text('', 40),
      opacity: z.number().min(0.01).max(0.4).default(0.045),
      /** Width as a fraction of the page. */
      scale: z.number().min(0.2).max(0.95).default(0.55),
      rotation: z.number().int().min(-90).max(90).default(0),
      position: position.default('center'),
    })
    .prefault({}),
});

export type InvoiceFormat = z.output<typeof invoiceFormatSchema>;
export type InvoiceFormatInput = z.input<typeof invoiceFormatSchema>;

export const DEFAULT_INVOICE_FORMAT: InvoiceFormat = invoiceFormatSchema.parse({});

/** Whatever is stored (null, partial, from an older version, even damaged) becomes a complete format. Never throws. */
export function resolveInvoiceFormat(raw: unknown): InvoiceFormat {
  const parsed = invoiceFormatSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : DEFAULT_INVOICE_FORMAT;
}
