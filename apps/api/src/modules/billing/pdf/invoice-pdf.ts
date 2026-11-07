import type { InstalmentStatus, InvoiceStatus } from '@legalops/types';
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
import { type Block, type DocModel, formatDate, formatINR, type ImageRef, isZero, type Line, renderDocument } from './layout.js';

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

/** Pure: everything the invoice PDF says, in order. Mirrors the web's InvoicePrintPage. */
export function invoiceDocumentModel(d: InvoiceDocData): DocModel {
  const { invoice: i, org, client } = d;
  const gst = i.taxMode === 'gst';
  const blocks: Block[] = [
    { kind: 'header', logo: d.logo, lines: letterheadLines(org), title: gst ? 'Tax invoice' : 'Invoice', number: i.invoiceNumber ?? 'DRAFT' },
  ];
  if (i.status === 'void') blocks.push({ kind: 'spacer', h: 4 }, { kind: 'banner', text: `VOID: ${i.voidReason ?? ''}` });

  const clientLines = [
    join([client.salutation, client.name], ' '),
    ...(client.contactPerson ? [`Attn: ${client.contactPerson}`] : []),
    ...(join([client.address, client.city, client.state]) ? [join([client.address, client.city, client.state])] : []),
    ...(i.recipientGstin ? [`GSTIN ${i.recipientGstin}`] : []),
  ];
  const right: [string, string][] = [
    ['Invoice date', formatDate(i.issueDate)],
    ['Due date', formatDate(i.dueDate)],
    ['Matter', i.matter.title],
  ];
  if (gst && i.placeOfSupply) right.push(['Place of supply', i.placeOfSupply]);
  blocks.push({ kind: 'columns', left: { label: 'Bill to', lines: clientLines }, right });

  blocks.push({
    kind: 'table',
    columns: gst
      ? [
          { header: 'Description', width: 0.43, align: 'left' },
          { header: 'SAC', width: 0.12, align: 'left' },
          { header: 'Qty', width: 0.08, align: 'right' },
          { header: 'Rate', width: 0.17, align: 'right' },
          { header: 'Amount', width: 0.2, align: 'right' },
        ]
      : [
          { header: 'Description', width: 0.55, align: 'left' },
          { header: 'Qty', width: 0.1, align: 'right' },
          { header: 'Rate', width: 0.17, align: 'right' },
          { header: 'Amount', width: 0.18, align: 'right' },
        ],
    rows: i.items.map((l) => ({
      cells: gst
        ? [l.description, l.sacCode ?? '—', String(Number(l.quantity)), formatINR(l.unitPrice), formatINR(l.amount)]
        : [l.description, String(Number(l.quantity)), formatINR(l.unitPrice), formatINR(l.amount)],
      ...(l.isPureAgent ? { note: 'Reimbursement as pure agent' } : {}),
    })),
  });

  const totals: { label: string; value: string; strong?: boolean }[] = [{ label: 'Subtotal', value: formatINR(i.subtotal) }];
  if (!isZero(i.discountAmount)) totals.push({ label: 'Discount', value: `− ${formatINR(i.discountAmount)}` });
  if (!isZero(i.cgst)) totals.push({ label: 'CGST', value: formatINR(i.cgst) });
  if (!isZero(i.sgst)) totals.push({ label: 'SGST', value: formatINR(i.sgst) });
  if (!isZero(i.igst)) totals.push({ label: 'IGST', value: formatINR(i.igst) });
  if (!gst && !isZero(i.taxAmount)) totals.push({ label: 'Tax', value: formatINR(i.taxAmount) });
  totals.push({ label: 'Total', value: formatINR(i.total), strong: true });
  if (!isZero(i.amountPaid)) totals.push({ label: 'Paid', value: formatINR(i.amountPaid) });
  if (!isZero(i.amountCredited)) totals.push({ label: 'Credited', value: formatINR(i.amountCredited) });
  totals.push({ label: 'Balance due', value: formatINR(i.amountDue), strong: true });
  blocks.push({ kind: 'totals', rows: totals });

  if (i.isReverseCharge)
    blocks.push({
      kind: 'text',
      text: `Tax payable on reverse charge basis: Yes. GST of ${formatINR(i.rcmTax)} is payable by the recipient.`,
    });

  if (i.instalments.length > 0)
    blocks.push({
      kind: 'table',
      title: 'Payment schedule',
      columns: [
        { header: '#', width: 0.08, align: 'left' },
        { header: 'Due date', width: 0.3, align: 'left' },
        { header: 'Amount', width: 0.22, align: 'right' },
        { header: 'Paid', width: 0.22, align: 'right' },
        { header: 'Status', width: 0.18, align: 'right' },
      ],
      rows: i.instalments.map((n) => ({
        cells: [String(n.seq), formatDate(n.dueDate), formatINR(n.amount), formatINR(n.paid), INSTALMENT_STATUS[n.status]],
      })),
    });

  if (i.notes) blocks.push({ kind: 'spacer', h: 6 }, { kind: 'text', text: i.notes });
  const bank = bankLines(org);
  if (bank.length > 0) blocks.push({ kind: 'box', title: 'Payment details', lines: bank });

  if (i.signatory)
    blocks.push({
      kind: 'signature',
      image: i.signatory.withImage ? d.signature : null,
      lines: [i.signatory.name, i.signatory.designation, `For ${org.legalName ?? org.name}`],
    });
  blocks.push({ kind: 'spacer', h: 6 });
  if (i.revision > 0) blocks.push({ kind: 'text', text: `Revision ${i.revision} · ${formatDate(i.revisedAt)}`, muted: true, size: 8.5 });
  blocks.push({ kind: 'text', text: 'This is a computer-generated invoice. Powered by LexForgeX', muted: true, size: 8.5 });
  return { title: `Invoice ${i.invoiceNumber ?? ''}`.trim(), blocks };
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
  const [{ org, logo }, client, sig] = await Promise.all([
    loadLetterhead(deps, deps.pool, ctx.organizationId),
    queryOne<{ name: string; salutation: string | null; contact_person: string | null; address: string | null; city: string | null; state: string | null }>(
      deps.pool,
      sql`SELECT name, salutation, contact_person, address, city, state FROM clients WHERE id = ${inv.client.id} AND organization_id = ${ctx.organizationId}`,
    ),
    queryOne<{ k: string | null }>(deps.pool, sql`SELECT signatory_signature_key AS k FROM invoices WHERE id = ${invoiceId}`),
  ]);
  if (!client) throw notFound('Client');
  const signature = inv.signatory?.withImage ? await readImage(deps.storage, sig?.k ?? null) : null;
  return {
    // The GSTIN printed on the invoice is the one captured at issue, not whatever the firm has set since.
    org: { ...org, gstin: inv.supplierGstin ?? org.gstin },
    logo,
    signature,
    client: { name: client.name, salutation: client.salutation, contactPerson: client.contact_person, address: client.address, city: client.city, state: client.state },
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
