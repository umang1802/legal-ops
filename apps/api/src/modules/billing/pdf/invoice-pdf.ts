import type { InstalmentStatus, InvoiceStatus } from '@legalops/types';
import { DEFAULT_INVOICE_FORMAT, resolveInvoiceFormat, type InvoiceFormat } from '@legalops/validation';
import { type Db, queryOne } from '../../../db/pool.js';
import { sql } from '../../../db/sql.js';
import type { Deps } from '../../../deps.js';
import type { TenantContext } from '../../../http/context.js';
import { notFound } from '../../../http/errors.js';
import { logoKey } from '../../organizations/logo.service.js';
import { MAX_SIGNED_PDF_BYTES } from '../dsc-check.js';
import { getInvoice } from '../invoices.service.js';
import { activeSignedDocument } from '../signed-documents.service.js';
import { readImage } from './images.js';
import { type Block, type DocModel, formatDate, formatMoney, type ImageRef, isZero, type Line, renderDocument } from './layout.js';

/** What a firm letterhead and payment box need; shared with the receipt. */
export type PdfOrg = {
  name: string;
  legalName: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  email: string | null;
  phone: string | null;
  gstin: string | null;
  pan: string | null;
  registrationLabel: string | null;
  registrationValue: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
  bankName: string | null;
  bankBranch: string | null;
  upiId: string | null;
};

export type InvoiceDocData = {
  org: PdfOrg;
  client: {
    name: string;
    salutation: string | null;
    contactPerson: string | null;
    address: string | null;
    city: string | null;
    state: string | null;
    email?: string | null;
    phone?: string | null;
  };
  invoice: {
    invoiceNumber: string | null;
    status: InvoiceStatus;
    voidReason: string | null;
    taxMode: 'simple' | 'gst';
    issueDate: string | null;
    dueDate: string | null;
    matter: { title: string };
    recipientGstin: string | null;
    placeOfSupply: string | null;
    isReverseCharge: boolean;
    rcmTax: string;
    subtotal: string;
    discountAmount: string;
    cgst: string;
    sgst: string;
    igst: string;
    taxAmount: string;
    total: string;
    amountPaid: string;
    amountCredited: string;
    amountDue: string;
    notes: string | null;
    revision: number;
    revisedAt: string | null;
    items: { description: string; quantity: string; unitPrice: string; amount: string; sacCode: string | null; isPureAgent: boolean }[];
    instalments: { seq: number; amount: string; dueDate: string; paid: string; status: InstalmentStatus }[];
    signatory: { name: string; designation: string; withImage: boolean } | null;
  };
  logo: ImageRef | null;
  signature: ImageRef | null;
  /** The firm's invoice format; the standard one when absent. */
  format?: InvoiceFormat;
};

const join = (parts: (string | null | undefined)[], sep = ', ') => parts.filter(Boolean).join(sep);

/** Firm letterhead lines, shared by invoice and receipt. */
export function letterheadLines(org: PdfOrg): Line[] {
  const lines: Line[] = [{ text: org.legalName ?? org.name, bold: true, size: 13 }];
  const addr = join([org.address, org.city, org.state, org.pincode]);
  if (addr) lines.push({ text: addr, muted: true, size: 8.5 });
  const contact = join([org.email, org.phone], ' · ');
  if (contact) lines.push({ text: contact, muted: true, size: 8.5 });
  if (org.gstin) lines.push({ text: `GSTIN ${org.gstin}`, muted: true, size: 8.5 });
  if (org.pan) lines.push({ text: `PAN ${org.pan}`, muted: true, size: 8.5 });
  if (org.registrationValue)
    lines.push({ text: `${org.registrationLabel ? `${org.registrationLabel}: ` : ''}${org.registrationValue}`, muted: true, size: 8.5 });
  return lines;
}

export function bankLines(org: PdfOrg): string[] {
  const rows: [string, string | null][] = [
    ['Account name', org.bankAccountName],
    ['Account number', org.bankAccountNumber],
    ['IFSC', org.bankIfsc],
    ['Bank', org.bankName],
    ['Branch', org.bankBranch],
    ['UPI', org.upiId],
  ];
  return rows.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
}

const INSTALMENT_STATUS: Record<InstalmentStatus, string> = { paid: 'Paid', part_paid: 'Part paid', due: 'Due', overdue: 'Overdue' };

const LOGO_HEIGHT = { small: 40, medium: 60, large: 80 } as const;

/** Account rows in the order people read them on a bank slip. */
export function bankRows(org: PdfOrg): string[] {
  const rows: [string, string | null][] = [
    ['Account Name', org.bankAccountName],
    ['Bank', org.bankName],
    ['Account No.', org.bankAccountNumber],
    ['IFSC', org.bankIfsc],
    ['Branch', org.bankBranch],
    ['UPI', org.upiId],
  ];
  return rows.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
}

/**
 * Pure: everything the invoice says, in the order and style the firm's format asks for. The PDF, the print page and the
 * format-settings preview all draw this one model, so they can't disagree.
 */
export function invoiceDocumentModel(d: InvoiceDocData, format: InvoiceFormat = d.format ?? DEFAULT_INVOICE_FORMAT): DocModel {
  const { invoice: i, org, client } = d;
  const gst = i.taxMode === 'gst';
  const money = (v: string) => formatMoney(v, format.currencyStyle);
  const firm = org.legalName ?? org.name;
  const blocks: Block[] = [];

  // ---- Letterhead ----
  const lh = format.letterhead;
  const lines: Line[] = [];
  if (lh.showName) lines.push({ text: lh.uppercaseName ? firm.toUpperCase() : firm, bold: true, size: 15, accent: true });
  if (lh.showRegistration && org.registrationValue) {
    lines.push({ text: `${org.registrationLabel ? `${org.registrationLabel}: ` : ''}${org.registrationValue}`, muted: true, size: 9 });
  }
  if (lh.showAddress) {
    const addr = join([org.address, org.city, org.state]);
    const full = `${addr}${org.pincode ? `${addr ? ' – ' : ''}${org.pincode}` : ''}`;
    if (full) lines.push({ text: join([lh.addressPrefix.trim(), full], ' '), muted: true, size: 9 });
  }
  if (lh.showGstin && org.gstin) lines.push({ text: `GSTIN ${org.gstin}`, muted: true, size: 9 });
  if (lh.showContact) {
    const contact = join([org.email, org.phone], ' · ');
    if (contact) lines.push({ text: contact, muted: true, size: 9 });
  }
  if (lh.showLogo || lines.length > 0) {
    blocks.push({ kind: 'letterhead', align: lh.align, logo: lh.showLogo ? d.logo : null, logoHeight: LOGO_HEIGHT[lh.logoSize], lines, rule: lh.rule });
  }
  blocks.push({ kind: 'title', text: gst ? format.title.taxText : format.title.text, align: format.title.align });
  if (i.status === 'void') blocks.push({ kind: 'banner', text: `VOID: ${i.voidReason ?? ''}` });

  // ---- Sections, in the firm's order ----
  for (const section of format.sections) {
    if (!section.show) continue;
    switch (section.id) {
      case 'parties': {
        const addr = join([client.address, client.city, client.state]);
        const p = format.parties;
        const left = [
          ...(p.showAttention && client.contactPerson ? [`Attn: ${client.contactPerson}`] : []),
          ...(addr ? [addr] : []),
          ...(p.showEmail && client.email ? [client.email] : []),
          ...(p.showPhone && client.phone ? [client.phone] : []),
          ...(p.showClientGstin && i.recipientGstin ? [`GSTIN ${i.recipientGstin}`] : []),
        ];
        const values: Record<string, string | null> = {
          number: i.invoiceNumber ?? 'DRAFT',
          date: formatDate(i.issueDate),
          dueDate: formatDate(i.dueDate),
          amountDue: money(i.amountDue),
          pan: org.pan,
          gstin: org.gstin,
          placeOfSupply: gst ? i.placeOfSupply : null,
          matter: i.matter.title,
        };
        const rows = p.details.filter((r) => r.show && values[r.id]).map((r) => ({ label: r.label, value: values[r.id]! }));
        blocks.push({
          kind: 'parties',
          left: { label: p.billedToLabel, name: join([client.salutation, client.name], ' '), lines: left },
          right: { label: p.detailsLabel, rows },
          detailsSide: p.detailsSide,
        });
        break;
      }
      case 'subject':
        if (i.matter.title) blocks.push({ kind: 'subject', label: format.subject.label, text: i.matter.title });
        break;
      case 'items': {
        const it = format.items;
        // A quantity other than 1 must be visible, or the amount on that line can't be checked against anything.
        const qtyRate = it.showQuantityRate || i.items.some((l) => Number(l.quantity) !== 1);
        const fixed = (it.showNumber ? 0.06 : 0) + (gst ? 0.12 : 0) + (qtyRate ? 0.24 : 0) + 0.2;
        const columns: { header: string; width: number; align: 'left' | 'right' }[] = [];
        if (it.showNumber) columns.push({ header: it.numberLabel, width: 0.06, align: 'left' });
        columns.push({ header: it.descriptionLabel, width: 1 - fixed, align: 'left' });
        if (gst) columns.push({ header: 'SAC', width: 0.12, align: 'left' });
        if (qtyRate) columns.push({ header: 'QTY', width: 0.08, align: 'right' }, { header: 'RATE', width: 0.16, align: 'right' });
        columns.push({ header: it.amountLabel, width: 0.2, align: 'right' });
        blocks.push({
          kind: 'table',
          filled: it.filledHeader,
          noteColumn: it.showNumber ? 1 : 0,
          columns,
          rows: i.items.map((l, n) => ({
            cells: [
              ...(it.showNumber ? [String(n + 1)] : []),
              l.description,
              ...(gst ? [l.sacCode ?? '—'] : []),
              ...(qtyRate ? [String(Number(l.quantity)), money(l.unitPrice)] : []),
              money(l.amount),
            ],
            ...(l.isPureAgent ? { note: 'Reimbursement as pure agent' } : {}),
          })),
        });

        const breakdown = !isZero(i.discountAmount) || !isZero(i.cgst) || !isZero(i.sgst) || !isZero(i.igst) || (!gst && !isZero(i.taxAmount));
        const totals: { label: string; value: string; strong?: boolean }[] = [];
        if (breakdown) {
          totals.push({ label: 'Subtotal', value: money(i.subtotal) });
          if (!isZero(i.discountAmount)) totals.push({ label: 'Discount', value: `− ${money(i.discountAmount)}` });
          if (!isZero(i.cgst)) totals.push({ label: 'CGST', value: money(i.cgst) });
          if (!isZero(i.sgst)) totals.push({ label: 'SGST', value: money(i.sgst) });
          if (!isZero(i.igst)) totals.push({ label: 'IGST', value: money(i.igst) });
          if (!gst && !isZero(i.taxAmount)) totals.push({ label: 'Tax', value: money(i.taxAmount) });
        }
        totals.push({ label: format.totals.totalLabel, value: money(i.total), strong: true });
        const settled = !isZero(i.amountPaid) || !isZero(i.amountCredited);
        if (!isZero(i.amountPaid)) totals.push({ label: 'Paid', value: money(i.amountPaid) });
        if (!isZero(i.amountCredited)) totals.push({ label: 'Credited', value: money(i.amountCredited) });
        if (settled) totals.push({ label: 'Balance due', value: money(i.amountDue), strong: true });
        blocks.push({ kind: 'totals', rows: totals, accent: format.totals.accent });
        if (i.isReverseCharge) {
          blocks.push({ kind: 'text', text: `Tax payable on reverse charge basis: Yes. GST of ${money(i.rcmTax)} is payable by the recipient.` });
        }
        break;
      }
      case 'schedule':
        if (i.instalments.length > 0) {
          blocks.push({
            kind: 'table',
            title: format.schedule.title,
            columns: [
              { header: '#', width: 0.08, align: 'left' },
              { header: 'Due date', width: 0.3, align: 'left' },
              { header: 'Amount', width: 0.22, align: 'right' },
              { header: 'Paid', width: 0.22, align: 'right' },
              { header: 'Status', width: 0.18, align: 'right' },
            ],
            rows: i.instalments.map((n) => ({ cells: [String(n.seq), formatDate(n.dueDate), money(n.amount), money(n.paid), INSTALMENT_STATUS[n.status]] })),
          });
        }
        break;
      case 'payment': {
        const bank = bankRows(org);
        if (bank.length > 0) {
          blocks.push({
            kind: 'labeled',
            label: format.payment.title,
            lines: [...(format.payment.intro ? [{ text: format.payment.intro }] : []), ...bank.map((text) => ({ text, indent: true }))],
          });
        }
        break;
      }
      case 'notes':
        if (i.notes) blocks.push({ kind: 'labeled', label: format.notes.title, lines: i.notes.split('\n').map((text) => ({ text })) });
        break;
      case 'signature':
        if (i.signatory) {
          const sg = format.signature;
          blocks.push({
            kind: 'signature',
            image: i.signatory.withImage ? d.signature : null,
            lines: [i.signatory.name, i.signatory.designation],
            heading: sg.onBehalfText.replaceAll('{firm}', firm).trim() || null,
            align: sg.align,
            accentName: sg.accentName,
          });
        }
        break;
    }
  }
  if (i.revision > 0) blocks.push({ kind: 'spacer', h: 6 }, { kind: 'text', text: `Revision ${i.revision} · ${formatDate(i.revisedAt)}`, muted: true, size: 8.5 });

  // ---- Footer and watermark ----
  const f = format.footer;
  const contact = f.showContact ? join([org.phone, org.email, f.website], '   |   ') : f.website;
  const wm = format.watermark;
  return {
    title: `Invoice ${i.invoiceNumber ?? ''}`.trim(),
    blocks,
    theme: { accent: format.accentColor, rule: format.ruleColor },
    ...(f.show ? { footer: { thankYou: f.thankYou || null, contact: contact || null, tagline: f.tagline || null, poweredBy: f.poweredBy, rule: f.rule } } : {}),
    ...(wm.mode === 'logo' && d.logo
      ? { watermark: { kind: 'image' as const, image: d.logo, opacity: wm.opacity, scale: wm.scale, rotation: wm.rotation, position: wm.position } }
      : wm.mode === 'text' && wm.text
        ? { watermark: { kind: 'text' as const, text: wm.text, opacity: wm.opacity, scale: wm.scale, rotation: wm.rotation, position: wm.position } }
        : {}),
  };
}

/** Org + logo for a letterhead. A logo that can't be read is skipped, never an error. */
export async function loadLetterhead(deps: Deps, db: Db, organizationId: string): Promise<{ org: PdfOrg; logo: ImageRef | null }> {
  const o = await queryOne<Record<string, string | null>>(
    db,
    sql`SELECT name, legal_name, address, city, state, pincode, email, phone, gstin, pan, registration_label, registration_value,
               bank_account_name, bank_account_number, bank_ifsc, bank_name, bank_branch, upi_id, logo_id::text AS logo_id, logo_type
        FROM organizations WHERE id = ${organizationId}`,
  );
  if (!o) throw notFound('Organization');
  const org: PdfOrg = {
    name: o.name!,
    legalName: o.legal_name ?? null,
    address: o.address ?? null,
    city: o.city ?? null,
    state: o.state ?? null,
    pincode: o.pincode ?? null,
    email: o.email ?? null,
    phone: o.phone ?? null,
    gstin: o.gstin ?? null,
    pan: o.pan ?? null,
    registrationLabel: o.registration_label ?? null,
    registrationValue: o.registration_value ?? null,
    bankAccountName: o.bank_account_name ?? null,
    bankAccountNumber: o.bank_account_number ?? null,
    bankIfsc: o.bank_ifsc ?? null,
    bankName: o.bank_name ?? null,
    bankBranch: o.bank_branch ?? null,
    upiId: o.upi_id ?? null,
  };
  const logo = o.logo_id && o.logo_type ? await readImage(deps.storage, logoKey(organizationId, o.logo_id, o.logo_type)) : null;
  return { org, logo };
}

/** Reads the invoice through the caller's visibility (404 when they can't see its matter), then gathers the rest. */
export async function loadInvoiceDocData(deps: Deps, ctx: TenantContext, invoiceId: string): Promise<InvoiceDocData> {
  const inv = await getInvoice(deps.pool, ctx, invoiceId);
  const [{ org, logo }, client, sig, fmt] = await Promise.all([
    loadLetterhead(deps, deps.pool, ctx.organizationId),
    queryOne<{ name: string; salutation: string | null; contact_person: string | null; address: string | null; city: string | null; state: string | null; email: string | null; phone: string | null }>(
      deps.pool,
      sql`SELECT name, salutation, contact_person, address, city, state, email::text AS email, phone FROM clients WHERE id = ${inv.client.id} AND organization_id = ${ctx.organizationId}`,
    ),
    queryOne<{ k: string | null }>(deps.pool, sql`SELECT signatory_signature_key AS k FROM invoices WHERE id = ${invoiceId}`),
    queryOne<{ f: unknown }>(deps.pool, sql`SELECT invoice_format AS f FROM organizations WHERE id = ${ctx.organizationId}`),
  ]);
  if (!client) throw notFound('Client');
  const signature = inv.signatory?.withImage ? await readImage(deps.storage, sig?.k ?? null) : null;
  return {
    // The GSTIN printed on the invoice is the one captured at issue, not whatever the firm has set since.
    org: { ...org, gstin: inv.supplierGstin ?? org.gstin },
    logo,
    signature,
    format: resolveInvoiceFormat(fmt?.f),
    client: { name: client.name, salutation: client.salutation, contactPerson: client.contact_person, address: client.address, city: client.city, state: client.state, email: client.email, phone: client.phone },
    invoice: {
      invoiceNumber: inv.invoiceNumber,
      status: inv.status,
      voidReason: inv.voidReason,
      taxMode: inv.taxMode,
      issueDate: inv.issueDate,
      dueDate: inv.dueDate,
      matter: { title: inv.matter.title },
      recipientGstin: inv.recipientGstin,
      placeOfSupply: inv.placeOfSupply,
      isReverseCharge: inv.isReverseCharge,
      rcmTax: inv.rcmTax,
      subtotal: inv.subtotal,
      discountAmount: inv.discountAmount,
      cgst: inv.cgst,
      sgst: inv.sgst,
      igst: inv.igst,
      taxAmount: inv.taxAmount,
      total: inv.total,
      amountPaid: inv.amountPaid,
      amountCredited: inv.amountCredited,
      amountDue: inv.amountDue,
      notes: inv.notes,
      revision: inv.revision,
      revisedAt: inv.revisedAt,
      items: inv.items.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, amount: l.amount, sacCode: l.sacCode, isPureAgent: l.isPureAgent })),
      instalments: inv.instalments.map((n) => ({ seq: n.seq, amount: n.amount, dueDate: n.dueDate, paid: n.paid, status: n.status })),
      signatory: inv.signatory ? { name: inv.signatory.name, designation: inv.signatory.designation, withImage: inv.signatory.withImage } : null,
    },
  };
}

export async function renderInvoicePdf(deps: Deps, ctx: TenantContext, invoiceId: string): Promise<Buffer> {
  return renderDocument(invoiceDocumentModel(await loadInvoiceDocData(deps, ctx, invoiceId)));
}

/** The DSC-signed bytes when there is a current one, else the generated PDF. The caller must already be allowed to see the invoice. */
export async function invoicePdfBytes(deps: Deps, ctx: TenantContext, invoiceId: string, opts: { strictSigned?: boolean } = {}): Promise<Buffer> {
  const signed = await activeSignedDocument(deps.pool, invoiceId);
  if (signed) {
    const bytes = await deps.storage.readObject(signed.storageKey, MAX_SIGNED_PDF_BYTES);
    if (bytes) return bytes;
    // Sending path: never substitute the unsigned generated PDF for a signed one that should exist.
    if (opts.strictSigned) throw new Error('The signed PDF for this invoice is missing from storage');
  }
  return renderInvoicePdf(deps, ctx, invoiceId);
}

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * The PDF to attach when emailing an invoice (system context: no user, sees every matter of the firm). Task 8 makes it
 * prefers the active DSC-signed document.
 */
export async function invoicePdfForSending(deps: Deps, orgId: string, invoiceId: string): Promise<{ filename: string; content: Buffer }> {
  const ctx: TenantContext = { userId: NIL_UUID, organizationId: orgId, role: 'owner', features: [] };
  const inv = await getInvoice(deps.pool, ctx, invoiceId);
  const number = inv.invoiceNumber ?? invoiceId;
  return { filename: `Invoice-${number.replaceAll('/', '-')}.pdf`, content: await invoicePdfBytes(deps, ctx, invoiceId, { strictSigned: true }) };
}

/** A made-up invoice drawn with the firm's real letterhead, logo and bank details: what the format preview shows. */
export function sampleInvoiceDocData(letterhead: { org: PdfOrg; logo: ImageRef | null }, format: InvoiceFormat, today: string): InvoiceDocData {
  return {
    org: { ...letterhead.org, gstin: letterhead.org.gstin },
    logo: letterhead.logo,
    signature: null,
    format,
    client: {
      name: 'Sample Client Pvt Ltd',
      salutation: null,
      contactPerson: 'Contact Person',
      address: '12 MG Road',
      city: 'Mumbai',
      state: 'Maharashtra',
      email: 'accounts@sample-client.example',
      phone: '98XXXXXXXX',
    },
    invoice: {
      invoiceNumber: 'SAMPLE/2026-27/001',
      status: 'issued',
      voidReason: null,
      taxMode: 'simple',
      issueDate: today,
      dueDate: today,
      matter: { title: 'Drafting of submission before the Registrar' },
      recipientGstin: null,
      placeOfSupply: null,
      isReverseCharge: false,
      rcmTax: '0.00',
      subtotal: '15000.00',
      discountAmount: '0.00',
      cgst: '0.00',
      sgst: '0.00',
      igst: '0.00',
      taxAmount: '0.00',
      total: '15000.00',
      amountPaid: '0.00',
      amountCredited: '0.00',
      amountDue: '15000.00',
      notes: 'This is a sample invoice. Your own notes appear here, below the bank details.',
      revision: 0,
      revisedAt: null,
      items: [
        { description: 'Drafting of letter to be submitted before the Hon’ble Office of the Registrar, in the matter of a sample society', quantity: '1', unitPrice: '15000.00', amount: '15000.00', sacCode: null, isPureAgent: false },
      ],
      instalments: [],
      signatory: { name: 'Signatory Name', designation: 'Authorized Signatory', withImage: false },
    },
  };
}
