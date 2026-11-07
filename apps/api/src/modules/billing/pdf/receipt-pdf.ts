import { PAYMENT_METHOD_LABELS, type PaymentMethod } from '@legalops/types';
import type { Deps } from '../../../deps.js';
import type { TenantContext } from '../../../http/context.js';
import { getPayment } from '../payments.service.js';
import { letterheadLines, loadLetterhead, type PdfOrg } from './invoice-pdf.js';
import { type Block, type DocModel, formatDate, formatINR, type ImageRef, isZero, renderDocument } from './layout.js';

export type ReceiptDocData = {
  org: PdfOrg;
  logo: ImageRef | null;
  payment: {
    receiptNumber: string;
    status: 'posted' | 'reversed';
    reversalReason: string | null;
    client: { name: string };
    amount: string;
    tdsAmount: string;
    settlement: string;
    unallocated: string;
    paymentDate: string;
    method: PaymentMethod;
    referenceNumber: string | null;
    allocations: { invoiceNumber: string | null; amount: string; active: boolean }[];
  };
};

/** Pure: everything the receipt PDF says. Mirrors the web's ReceiptPrintPage. */
export function receiptDocumentModel(d: ReceiptDocData): DocModel {
  const p = d.payment;
  const blocks: Block[] = [{ kind: 'header', logo: d.logo, lines: letterheadLines(d.org), title: 'Receipt', number: p.receiptNumber }];
  if (p.status === 'reversed') blocks.push({ kind: 'spacer', h: 4 }, { kind: 'banner', text: `REVERSED: ${p.reversalReason ?? ''}` });
  blocks.push({ kind: 'spacer', h: 10 });
  blocks.push({
    kind: 'text',
    size: 11,
    text: `Received with thanks from ${p.client.name} the sum of ${formatINR(p.amount)} by ${PAYMENT_METHOD_LABELS[p.method]}${p.referenceNumber ? ` (ref. ${p.referenceNumber})` : ''} on ${formatDate(p.paymentDate)}.`,
  });
  if (!isZero(p.tdsAmount))
    blocks.push({ kind: 'text', text: `Tax deducted at source: ${formatINR(p.tdsAmount)}. Total settled: ${formatINR(p.settlement)}.` });
  const applied = p.allocations.filter((a) => a.active);
  if (applied.length > 0)
    blocks.push({
      kind: 'table',
      columns: [
        { header: 'Applied to invoice', width: 0.7, align: 'left' },
        { header: 'Amount', width: 0.3, align: 'right' },
      ],
      rows: applied.map((a) => ({ cells: [a.invoiceNumber ?? '—', formatINR(a.amount)] })),
    });
  if (!isZero(p.unallocated)) blocks.push({ kind: 'text', text: `Held as advance: ${formatINR(p.unallocated)}` });
  blocks.push({ kind: 'spacer', h: 16 });
  blocks.push({ kind: 'text', text: 'This is a computer-generated receipt. Powered by LexForgeX', muted: true, size: 8.5 });
  return { title: `Receipt ${p.receiptNumber}`, blocks };
}

/** Reads the payment through the caller's visibility (404 when they can't see it). */
export async function renderReceiptPdf(deps: Deps, ctx: TenantContext, paymentId: string): Promise<Buffer> {
  const pay = await getPayment(deps.pool, ctx, paymentId);
  const { org, logo } = await loadLetterhead(deps, deps.pool, ctx.organizationId);
  return renderDocument(
    receiptDocumentModel({
      org,
      logo,
      payment: {
        receiptNumber: pay.receiptNumber,
        status: pay.status,
        reversalReason: pay.reversalReason,
        client: { name: pay.client.name },
        amount: pay.amount,
        tdsAmount: pay.tdsAmount,
        settlement: pay.settlement,
        unallocated: pay.unallocated,
        paymentDate: pay.paymentDate,
        method: pay.method,
        referenceNumber: pay.referenceNumber,
        allocations: pay.allocations.map((a) => ({ invoiceNumber: a.invoiceNumber, amount: a.amount, active: a.active })),
      },
    }),
  );
}
