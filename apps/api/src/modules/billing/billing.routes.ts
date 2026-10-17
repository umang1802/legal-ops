import { AGING_BUCKETS } from '@legalops/types';
import {
  allocationSchema,
  createInvoiceSchema,
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
import { parse } from '../../http/validate.js';
import { requestMeta } from '../../middleware/request-context.js';
import { requireAnyPermission, requireAuth, requirePermission, tenant } from '../../middleware/security.js';
import * as expenses from './expenses.service.js';
import * as fees from './fee-agreements.service.js';
import * as invoices from './invoices.service.js';
import * as payments from './payments.service.js';
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
  r.delete('/:invoiceId', requirePermission('invoices.manage'), async (req, res) => {
    await invoices.deleteDraft(deps, tenant(req), id(req.params.invoiceId), requestMeta(req));
    res.status(204).end();
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
