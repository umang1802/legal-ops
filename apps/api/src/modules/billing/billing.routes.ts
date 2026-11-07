import { AGING_BUCKETS } from '@legalops/types';
import {
  allocationSchema,
  createInvoiceSchema,
  createPaymentLinkSchema,
  creditNoteSchema,
  expenseSchema,
  feeAgreementSchema,
  issueInvoiceSchema,
  listExpensesSchema,
  listInvoicesSchema,
  listPaymentsSchema,
  milestoneSchema,
  reasonSchema,
  recordPaymentSchema,
  reviseInvoiceSchema,
  tdsCertificateSchema,
  updateExpenseSchema,
  updateFeeAgreementSchema,
  updateInvoiceSchema,
  updateMilestoneSchema,
  uuidSchema,
} from '@legalops/validation';
import { Router } from 'express';
import { z } from 'zod';
import type { Deps } from '../../deps.js';
import { queryOne } from '../../db/pool.js';
import { sql } from '../../db/sql.js';
import { notFound } from '../../http/errors.js';
import { parse } from '../../http/validate.js';
import { contentDisposition } from '../../integrations/storage/document-storage.js';
import { requestMeta } from '../../middleware/request-context.js';
import { requireAnyPermission, requireAuth, requirePermission, tenant } from '../../middleware/security.js';
import * as paymentLinks from '../online-payments/payment-links.service.js';
import * as expenses from './expenses.service.js';
import * as fees from './fee-agreements.service.js';
import * as invoices from './invoices.service.js';
import * as payments from './payments.service.js';
import * as revisions from './revisions.service.js';
import { invoicePdfBytes } from './pdf/invoice-pdf.js';
import { readImage } from './pdf/images.js';
import { renderReceiptPdf } from './pdf/receipt-pdf.js';
import * as signed from './signed-documents.service.js';
import * as summary from './summary.service.js';

const id = (v: unknown) => parse(uuidSchema, v);

export function invoicesRouter(deps: Deps): Router {
  const r = Router();
  r.use(requireAuth);
  r.get('/', requirePermission('billing.view'), async (req, res) => {
    const f = parse(listInvoicesSchema, req.query);
    const { items, total } = await invoices.listInvoices(deps, tenant(req), f);
    res.json({ data: items, meta: { page: f.page, pageSize: f.pageSize, total } });
  });
  r.post('/', requirePermission('invoices.manage'), async (req, res) => {
    res.status(201).json({
      data: await invoices.createInvoice(
        deps,
        tenant(req),
        parse(createInvoiceSchema, req.body),
        requestMeta(req),
      ),
    });
  });
  r.get('/:invoiceId', requirePermission('billing.view'), async (req, res) => {
    res.json({ data: await invoices.getInvoice(deps.pool, tenant(req), id(req.params.invoiceId)) });
  });
  r.get('/:invoiceId/pdf', requirePermission('billing.view'), async (req, res) => {
    const ctx = tenant(req);
    const invoiceId = id(req.params.invoiceId);
    const inv = await invoices.getInvoice(deps.pool, ctx, invoiceId);
    const pdf = await invoicePdfBytes(deps, ctx, invoiceId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      contentDisposition(`Invoice-${(inv.invoiceNumber ?? 'draft').replaceAll('/', '-')}.pdf`, true),
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(pdf);
  });
  // The signature image as it was when the invoice was issued (the print page shows this, not the member's current one).
  r.get('/:invoiceId/signature', requirePermission('billing.view'), async (req, res) => {
    const ctx = tenant(req);
    const invoiceId = id(req.params.invoiceId);
    const inv = await invoices.getInvoice(deps.pool, ctx, invoiceId); // visibility → 404
    const row = await queryOne<{ k: string | null }>(
      deps.pool,
      sql`SELECT signatory_signature_key AS k FROM invoices WHERE id = ${invoiceId} AND organization_id = ${ctx.organizationId}`,
    );
    const img = inv.signatory?.withImage ? await readImage(deps.storage, row?.k ?? null) : null;
    if (!img) throw notFound('Signature');
    res
      .set({ 'Content-Type': img.mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' })
      .send(Buffer.from(img.bytes));
  });
  r.post('/:invoiceId/signed-document/uploads', requirePermission('invoices.manage'), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({ data: await signed.startSignedUpload(deps, tenant(req), id(req.params.invoiceId)) });
  });
  r.post('/:invoiceId/signed-document/uploads/:uploadId/complete', requirePermission('invoices.manage'), async (req, res) => {
    const ctx = tenant(req);
    const invoiceId = id(req.params.invoiceId);
    await signed.completeSignedUpload(deps, ctx, invoiceId, id(req.params.uploadId), requestMeta(req));
    res.json({ data: await invoices.getInvoice(deps.pool, ctx, invoiceId) });
  });
  r.delete('/:invoiceId/signed-document', requirePermission('invoices.manage'), async (req, res) => {
    const ctx = tenant(req);
    const invoiceId = id(req.params.invoiceId);
    await signed.removeSignedDocument(deps, ctx, invoiceId, requestMeta(req));
    res.json({ data: await invoices.getInvoice(deps.pool, ctx, invoiceId) });
  });
  r.patch('/:invoiceId', requirePermission('invoices.manage'), async (req, res) => {
    res.json({
      data: await invoices.updateDraft(
        deps,
        tenant(req),
        id(req.params.invoiceId),
        parse(updateInvoiceSchema, req.body),
        requestMeta(req),
      ),
    });
  });
  // Simple-mode invoices only: an in-place, revision-numbered edit after issue (GST invoices take a credit note).
  r.patch('/:invoiceId/revision', requirePermission('invoices.manage'), async (req, res) => {
    res.json({
      data: await revisions.reviseInvoice(
        deps,
        tenant(req),
        id(req.params.invoiceId),
        parse(reviseInvoiceSchema, req.body),
        requestMeta(req),
      ),
    });
  });
  r.delete('/:invoiceId', requirePermission('invoices.manage'), async (req, res) => {
    await invoices.deleteDraft(deps, tenant(req), id(req.params.invoiceId), requestMeta(req));
    res.status(204).end();
  });
  // Pay-online links (Zoho Payments). The webhook, not these routes, is what records the money.
  r.get('/:invoiceId/payment-links', requirePermission('billing.view'), async (req, res) => {
    res.json({ data: await paymentLinks.listInvoicePaymentLinks(deps.pool, deps, tenant(req), id(req.params.invoiceId)) });
  });
  r.post('/:invoiceId/payment-links', requirePermission('invoices.manage'), async (req, res) => {
    const input = parse(createPaymentLinkSchema, req.body);
    res.status(201).json({ data: await paymentLinks.createInvoicePaymentLink(deps, tenant(req), id(req.params.invoiceId), input, requestMeta(req)) });
  });
  r.post('/:invoiceId/instalments/:seq/send', requirePermission('invoices.manage'), async (req, res) => {
    const seq = parse(z.coerce.number().int().min(1).max(24), req.params.seq);
    res.json({ data: await paymentLinks.sendInstalmentNow(deps, tenant(req), id(req.params.invoiceId), seq, requestMeta(req)) });
  });
  r.post('/:invoiceId/payment-links/:linkId/cancel', requirePermission('invoices.manage'), async (req, res) => {
    res.json({ data: await paymentLinks.cancelInvoicePaymentLink(deps, tenant(req), id(req.params.invoiceId), id(req.params.linkId), requestMeta(req)) });
  });
  r.post('/:invoiceId/issue', requirePermission('invoices.manage'), async (req, res) => {
    res.json({
      data: await invoices.issueInvoice(
        deps,
        tenant(req),
        id(req.params.invoiceId),
        parse(issueInvoiceSchema, req.body),
        requestMeta(req),
      ),
    });
  });
  r.post('/:invoiceId/send', requirePermission('invoices.manage'), async (req, res) => {
    res.json({ data: await invoices.sendInvoice(deps, tenant(req), id(req.params.invoiceId), requestMeta(req)) });
  });
  r.post('/:invoiceId/void', requirePermission('invoices.manage'), async (req, res) => {
    const { reason } = parse(reasonSchema, req.body);
    res.json({
      data: await invoices.voidInvoice(deps, tenant(req), id(req.params.invoiceId), reason, requestMeta(req)),
    });
  });
  r.post('/:invoiceId/write-off', requirePermission('invoices.manage'), async (req, res) => {
    const { reason } = parse(reasonSchema, req.body);
    res.json({
      data: await invoices.writeOffInvoice(
        deps,
        tenant(req),
        id(req.params.invoiceId),
        reason,
        requestMeta(req),
      ),
    });
  });
  r.post('/:invoiceId/credit-notes', requirePermission('invoices.manage'), async (req, res) => {
    res.json({
      data: await invoices.issueCreditNote(
        deps,
        tenant(req),
        id(req.params.invoiceId),
        parse(creditNoteSchema, req.body),
        requestMeta(req),
      ),
    });
  });
  return r;
}

export function paymentsRouter(deps: Deps): Router {
  const r = Router();
  r.use(requireAuth);
  r.get('/', requirePermission('billing.view'), async (req, res) => {
    const f = parse(listPaymentsSchema, req.query);
    const { items, total } = await payments.listPayments(deps, tenant(req), f);
    res.json({ data: items, meta: { page: f.page, pageSize: f.pageSize, total } });
  });
  r.post('/', requirePermission('payments.record'), async (req, res) => {
    res.status(201).json({
      data: await payments.recordPayment(
        deps,
        tenant(req),
        parse(recordPaymentSchema, req.body),
        requestMeta(req),
      ),
    });
  });
  r.get('/:paymentId', requirePermission('billing.view'), async (req, res) => {
    res.json({ data: await payments.getPayment(deps.pool, tenant(req), id(req.params.paymentId)) });
  });
  r.get('/:paymentId/receipt.pdf', requirePermission('billing.view'), async (req, res) => {
    const ctx = tenant(req);
    const paymentId = id(req.params.paymentId);
    const pay = await payments.getPayment(deps.pool, ctx, paymentId);
    const pdf = await renderReceiptPdf(deps, ctx, paymentId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition(`Receipt-${pay.receiptNumber.replaceAll('/', '-')}.pdf`, true));
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(pdf);
  });
  r.post('/:paymentId/allocations', requirePermission('payments.record'), async (req, res) => {
    res.json({
      data: await payments.allocateAdvance(
        deps,
        tenant(req),
        id(req.params.paymentId),
        parse(allocationSchema, req.body),
        requestMeta(req),
      ),
    });
  });
  r.post(
    '/:paymentId/allocations/:allocationId/reverse',
    requirePermission('payments.record'),
    async (req, res) => {
      const { reason } = parse(reasonSchema, req.body);
      res.json({
        data: await payments.reverseAllocation(
          deps,
          tenant(req),
          id(req.params.paymentId),
          id(req.params.allocationId),
          reason,
          requestMeta(req),
        ),
      });
    },
  );
  r.post('/:paymentId/reverse', requirePermission('payments.record'), async (req, res) => {
    const { reason } = parse(reasonSchema, req.body);
    res.json({
      data: await payments.reversePayment(
        deps,
        tenant(req),
        id(req.params.paymentId),
        reason,
        requestMeta(req),
      ),
    });
  });
  r.post('/:paymentId/tds-certificate', requirePermission('payments.record'), async (req, res) => {
    res.json({
      data: await payments.recordTdsCertificate(
        deps,
        tenant(req),
        id(req.params.paymentId),
        parse(tdsCertificateSchema, req.body),
        requestMeta(req),
      ),
    });
  });
  return r;
}

export function expensesRouter(deps: Deps): Router {
  const r = Router();
  r.use(requireAuth);
  r.get('/', requireAnyPermission('billing.view', 'matters.view'), async (req, res) => {
    res.json({ data: await expenses.listExpenses(deps, tenant(req), parse(listExpensesSchema, req.query)) });
  });
  r.post('/', requireAnyPermission('matters.create', 'invoices.manage'), async (req, res) => {
    res.status(201).json({
      data: await expenses.createExpense(deps, tenant(req), parse(expenseSchema, req.body), requestMeta(req)),
    });
  });
  r.patch('/:expenseId', requireAnyPermission('matters.edit', 'invoices.manage'), async (req, res) => {
    res.json({
      data: await expenses.updateExpense(
        deps,
        tenant(req),
        id(req.params.expenseId),
        parse(updateExpenseSchema, req.body),
        requestMeta(req),
      ),
    });
  });
  r.post('/:expenseId/void', requireAnyPermission('matters.edit', 'invoices.manage'), async (req, res) => {
    const { reason } = parse(reasonSchema, req.body);
    res.json({
      data: await expenses.voidExpense(deps, tenant(req), id(req.params.expenseId), reason, requestMeta(req)),
    });
  });
  return r;
}

export function feeAgreementsRouter(deps: Deps): Router {
  const r = Router();
  r.use(requireAuth);
  r.get('/', requirePermission('billing.view'), async (req, res) => {
    const { matterId } = parse(z.object({ matterId: uuidSchema }), req.query);
    res.json({ data: await fees.listFeeAgreements(deps.pool, tenant(req), matterId) });
  });
  r.post('/', requirePermission('invoices.manage'), async (req, res) => {
    res.status(201).json({
      data: await fees.createFeeAgreement(
        deps,
        tenant(req),
        parse(feeAgreementSchema, req.body),
        requestMeta(req),
      ),
    });
  });
  r.patch('/:agreementId', requirePermission('invoices.manage'), async (req, res) => {
    res.json({
      data: await fees.updateFeeAgreement(
        deps,
        tenant(req),
        id(req.params.agreementId),
        parse(updateFeeAgreementSchema, req.body),
        requestMeta(req),
      ),
    });
  });
  r.post('/:agreementId/milestones', requirePermission('invoices.manage'), async (req, res) => {
    res.json({
      data: await fees.addMilestone(
        deps,
        tenant(req),
        id(req.params.agreementId),
        parse(milestoneSchema, req.body),
        requestMeta(req),
      ),
    });
  });
  return r;
}

export function feeMilestonesRouter(deps: Deps): Router {
  const r = Router();
  r.use(requireAuth);
  r.patch('/:milestoneId', requirePermission('invoices.manage'), async (req, res) => {
    res.json({
      data: await fees.updateMilestone(
        deps,
        tenant(req),
        id(req.params.milestoneId),
        parse(updateMilestoneSchema, req.body),
        requestMeta(req),
      ),
    });
  });
  return r;
}

export function billingRouter(deps: Deps): Router {
  const r = Router();
  r.use(requireAuth, requirePermission('billing.view'));
  r.get('/summary', async (req, res) => {
    res.json({ data: await summary.billingSummary(deps, tenant(req)) });
  });
  r.get('/aging', async (req, res) => {
    const { bucket } = parse(z.object({ bucket: z.enum(AGING_BUCKETS).optional() }), req.query);
    res.json({ data: await summary.agingList(deps, tenant(req), bucket) });
  });
  r.get('/matters/:matterId', async (req, res) => {
    res.json({ data: await summary.matterBilling(deps, tenant(req), id(req.params.matterId)) });
  });
  r.get('/clients/:clientId', async (req, res) => {
    res.json({ data: await summary.clientBalance(deps, tenant(req), id(req.params.clientId)) });
  });
  return r;
}
