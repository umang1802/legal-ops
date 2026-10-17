import type {
  InvoiceDetailDto,
  InvoiceDisplayStatus,
  InvoiceListItemDto,
  InvoiceStatus,
  PaymentMethod,
  PaymentState,
} from '@legalops/types';
import {
  computeInvoiceTotals,
  fromPaise,
  InvoiceCalcError,
  toPaise,
  type createInvoiceSchema,
  type creditNoteSchema,
  type listInvoicesSchema,
  type updateInvoiceSchema,
} from '@legalops/validation';
import type { z } from 'zod';
import { query, queryOne, withTransaction, type Db } from '../../db/pool.js';
import { sql, type SqlFragment } from '../../db/sql.js';
import type { Deps } from '../../deps.js';
import type { RequestMeta, TenantContext } from '../../http/context.js';
import { displayDate, orgToday } from '../../http/dates.js';
import { AppError, conflict, notFound, validationError } from '../../http/errors.js';
import { iso, likeContains, pageClause } from '../../http/query-helpers.js';
import { assertMatterVisible } from '../access/matter-scope.js';
import { recordAudit } from '../audit/audit.service.js';
import { emitEvent } from '../outbox/outbox.service.js';
import { addTimelineEvent } from '../timeline/timeline.service.js';
import { postLedger } from './ledger.js';
import { CREDIT_NOTE_PREFIX, nextDocumentNumber } from './numbering.js';
import { invoiceVisible } from './visibility.js';

const DEFAULT_PAYMENT_TERMS_DAYS = 15;

/** ₹ for timeline text. */
export const rupees = (paise: number) =>
  `₹${new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(paise / 100)}`;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

type InvoiceRow = {
  id: string;
  invoice_number: string | null;
  status: InvoiceStatus;
  payment_state: PaymentState | null;
  days_overdue: number;
  issue_date: string | null;
  due_date: string | null;
  client_id: string;
  client_name: string;
  matter_id: string;
  matter_title: string;
  total_amount: string;
  amount_paid: string;
  amount_credited: string;
  amount_due: string;
  currency: string;
};

/** Balances come from v_invoice_balances (derived from allocations + credit notes), never a cached column. */
export const INVOICE_SELECT = sql`
  i.id, i.invoice_number, i.status, b.payment_state,
  CASE WHEN i.status = 'issued' AND b.amount_due > 0 AND i.due_date < (now() AT TIME ZONE o.timezone)::date
       THEN ((now() AT TIME ZONE o.timezone)::date - i.due_date) ELSE 0 END AS days_overdue,
  i.issue_date::text AS issue_date, i.due_date::text AS due_date,
  c.id AS client_id, c.name AS client_name, m.id AS matter_id, m.title AS matter_title,
  i.total_amount::text, b.amount_paid::text, b.amount_credited::text, b.amount_due::text, i.currency`;

export const INVOICE_FROM = sql`
  invoices i
  JOIN v_invoice_balances b ON b.invoice_id = i.id
  JOIN organizations o ON o.id = i.organization_id
  JOIN clients c ON c.id = i.client_id
  JOIN matters m ON m.id = i.matter_id`;

export function displayStatus(
  r: Pick<InvoiceRow, 'status' | 'payment_state' | 'days_overdue'>,
): InvoiceDisplayStatus {
  if (r.status !== 'issued') return r.status;
  if (r.payment_state === 'paid') return 'paid';
  if (r.days_overdue > 0) return 'overdue';
  return r.payment_state === 'partial' ? 'partial' : 'unpaid';
}

export const toListItem = (r: InvoiceRow): InvoiceListItemDto => ({
  id: r.id,
  invoiceNumber: r.invoice_number,
  status: r.status,
  paymentState: r.payment_state,
  displayStatus: displayStatus(r),
  daysOverdue: r.days_overdue,
  issueDate: r.issue_date,
  dueDate: r.due_date,
  client: { id: r.client_id, name: r.client_name },
  matter: { id: r.matter_id, title: r.matter_title },
  total: r.total_amount,
  amountPaid: r.amount_paid,
  amountCredited: r.amount_credited,
  amountDue: r.amount_due,
  currency: r.currency,
});

/** Shared by list, billing summary, aging and matter/client views. */
export async function queryInvoices(
  db: Db,
  ctx: TenantContext,
  where: SqlFragment[],
  order: SqlFragment,
  page?: { page: number; pageSize: number },
): Promise<{ items: InvoiceListItemDto[]; total: number }> {
  const rows = await query<InvoiceRow & { total: number }>(
    db,
    sql`SELECT ${INVOICE_SELECT}, count(*) OVER ()::int AS total FROM ${INVOICE_FROM}
        WHERE ${sql.join([sql`i.organization_id = ${ctx.organizationId}`, invoiceVisible(ctx), ...where], ' AND ')}
        ORDER BY ${order}
        ${page ? pageClause(page) : sql`LIMIT 500`}`,
  );
  return { items: rows.map(toListItem), total: rows[0]?.total ?? 0 };
}

const TODAY = sql`(now() AT TIME ZONE o.timezone)::date`;
export const OPEN_ISSUED = sql`i.status = 'issued' AND b.amount_due > 0`;

export async function listInvoices(deps: Deps, ctx: TenantContext, f: z.output<typeof listInvoicesSchema>) {
  const where: SqlFragment[] = [];
  switch (f.status) {
    case 'open':
      where.push(OPEN_ISSUED);
      break;
    case 'draft':
    case 'void':
    case 'written_off':
      where.push(sql`i.status = ${f.status}`);
      break;
    case 'paid':
      where.push(sql`i.status = 'issued' AND b.payment_state = 'paid'`);
      break;
    case 'partial':
      where.push(sql`${OPEN_ISSUED} AND b.payment_state = 'partial' AND i.due_date >= ${TODAY}`);
      break;
    case 'unpaid':
      where.push(sql`${OPEN_ISSUED} AND b.payment_state = 'unpaid' AND i.due_date >= ${TODAY}`);
      break;
    case 'overdue':
      where.push(sql`${OPEN_ISSUED} AND i.due_date < ${TODAY}`);
      break;
    case 'all':
      break;
  }
  if (f.clientId) where.push(sql`i.client_id = ${f.clientId}`);
  if (f.matterId) where.push(sql`i.matter_id = ${f.matterId}`);
  if (f.dueFrom) where.push(sql`i.due_date >= ${f.dueFrom}`);
  if (f.dueTo) where.push(sql`i.due_date <= ${f.dueTo}`);
  if (f.search)
    where.push(
      sql`(i.invoice_number ILIKE ${likeContains(f.search)} OR c.name ILIKE ${likeContains(f.search)} OR m.title ILIKE ${likeContains(f.search)})`,
    );
  const order =
    f.status === 'overdue'
      ? sql`i.due_date ASC`
      : sql`CASE i.status WHEN 'draft' THEN 0 ELSE 1 END, i.issue_date DESC NULLS FIRST, i.created_at DESC`;
  return queryInvoices(deps.pool, ctx, where, order, f);
}

export async function getInvoice(db: Db, ctx: TenantContext, id: string): Promise<InvoiceDetailDto> {
  const { items } = await queryInvoices(db, ctx, [sql`i.id = ${id}`], sql`i.id`);
  const base = items[0];
  if (!base) throw notFound('Invoice');
  const d = (await queryOne<Record<string, unknown>>(
    db,
    sql`SELECT i.tax_mode, i.supplier_gstin, i.supplier_state_code, i.recipient_gstin, i.recipient_state_code,
               i.place_of_supply, i.is_reverse_charge, i.subtotal::text, i.discount_amount::text, i.cgst_amount::text,
               i.sgst_amount::text, i.igst_amount::text, i.rcm_tax_amount::text, i.tax_amount::text, i.notes,
               i.issued_at, i.voided_at, i.void_reason, i.write_off_reason, i.created_at,
               u.id AS created_by, u.first_name, u.last_name
        FROM invoices i LEFT JOIN users u ON u.id = i.created_by WHERE i.id = ${id}`,
  ))!;
  const items2 = await query<{
    id: string;
    position: number;
    description: string;
    quantity: string;
    unit_price: string;
    amount: string;
    sac_code: string | null;
    gst_rate: string | null;
    is_pure_agent: boolean;
    fee_milestone_id: string | null;
    expense_id: string | null;
  }>(
    db,
    sql`SELECT id, position, description, quantity::text, unit_price::text, amount::text, sac_code, gst_rate::text,
               is_pure_agent, fee_milestone_id, expense_id
        FROM invoice_items WHERE invoice_id = ${id} ORDER BY position, created_at`,
  );
  const allocations = await query<{
    id: string;
    payment_id: string;
    receipt_number: string;
    payment_date: string;
    payment_method: PaymentMethod;
    amount: string;
    active: boolean;
  }>(
    db,
    sql`SELECT a.id, a.payment_id, p.receipt_number, p.payment_date::text, p.payment_method, a.amount::text,
               (a.status = 'active' AND p.status = 'posted') AS active
        FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
        WHERE a.invoice_id = ${id} ORDER BY p.payment_date, a.created_at`,
  );
  const creditNotes = await query<{
    id: string;
    credit_note_number: string;
    issue_date: string;
    amount: string;
    reason: string;
  }>(
    db,
    sql`SELECT id, credit_note_number, issue_date::text, amount::text, reason FROM credit_notes WHERE invoice_id = ${id} ORDER BY created_at`,
  );
  return {
    ...base,
    taxMode: d.tax_mode as 'simple' | 'gst',
    supplierGstin: d.supplier_gstin as string | null,
    supplierStateCode: d.supplier_state_code as string | null,
    recipientGstin: d.recipient_gstin as string | null,
    recipientStateCode: d.recipient_state_code as string | null,
    placeOfSupply: d.place_of_supply as string | null,
    isReverseCharge: d.is_reverse_charge as boolean,
    subtotal: d.subtotal as string,
    discountAmount: d.discount_amount as string,
    cgst: d.cgst_amount as string,
    sgst: d.sgst_amount as string,
    igst: d.igst_amount as string,
    rcmTax: d.rcm_tax_amount as string,
    taxAmount: d.tax_amount as string,
    notes: d.notes as string | null,
    items: items2.map((l) => ({
      id: l.id,
      position: l.position,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unit_price,
      amount: l.amount,
      sacCode: l.sac_code,
      gstRate: l.gst_rate,
      isPureAgent: l.is_pure_agent,
      feeMilestoneId: l.fee_milestone_id,
      expenseId: l.expense_id,
    })),
    allocations: allocations.map((a) => ({
      id: a.id,
      paymentId: a.payment_id,
      receiptNumber: a.receipt_number,
      paymentDate: a.payment_date,
      method: a.payment_method,
      amount: a.amount,
      active: a.active,
    })),
    creditNotes: creditNotes.map((c) => ({
      id: c.id,
      number: c.credit_note_number,
      issueDate: c.issue_date,
      amount: c.amount,
      reason: c.reason,
    })),
    issuedAt: iso(d.issued_at as Date | null),
    voidedAt: iso(d.voided_at as Date | null),
    voidReason: d.void_reason as string | null,
    writeOffReason: d.write_off_reason as string | null,
    createdBy: d.created_by
      ? {
          userId: d.created_by as string,
          firstName: (d.first_name as string) ?? '',
          lastName: d.last_name as string | null,
        }
      : null,
    createdAt: iso(d.created_at as Date)!,
  };
}

// ---------------------------------------------------------------------------
// Drafting
// ---------------------------------------------------------------------------

type OrgTax = {
  tax_mode: 'simple' | 'gst';
  gstin: string | null;
  state_code: string | null;
  invoice_prefix: string;
  default_sac_code: string | null;
  default_gst_rate: string | null;
  settings: { paymentTermsDays?: number };
};

async function loadOrgTax(db: Db, organizationId: string): Promise<OrgTax> {
  return (await queryOne<OrgTax>(
    db,
    sql`SELECT tax_mode, gstin, state_code, invoice_prefix, default_sac_code, default_gst_rate::text, settings
        FROM organizations WHERE id = ${organizationId}`,
  ))!;
}

type DraftInput = z.output<typeof updateInvoiceSchema>;
type Item = DraftInput['items'][number];

/** Fills GST defaults, validates milestone/expense links, and computes totals. */
async function prepareDraft(
  db: Db,
  ctx: TenantContext,
  matterId: string,
  taxMode: 'simple' | 'gst',
  input: DraftInput,
  org: OrgTax,
  client: { state_code: string | null; gstin: string | null; client_type: string },
  invoiceId: string | null,
) {
  const items: Item[] = input.items.map(
    (it) =>
      taxMode === 'gst' && !it.isPureAgent
        ? {
            ...it,
            gstRate: it.gstRate ?? org.default_gst_rate ?? '18',
            sacCode: it.sacCode ?? org.default_sac_code ?? null,
          }
        : { ...it, gstRate: null }, // simple mode, or a pure-agent reimbursement: never taxed
  );

  // Linked milestones/expenses must belong to this matter and not already be billed elsewhere.
  for (const [i, it] of items.entries()) {
    if (it.feeMilestoneId) {
      const m = await queryOne<{ status: string; invoice_id: string | null }>(
        db,
        sql`SELECT fm.status, fm.invoice_id FROM fee_milestones fm JOIN fee_agreements fa ON fa.id = fm.fee_agreement_id
            WHERE fm.id = ${it.feeMilestoneId} AND fa.matter_id = ${matterId} AND fm.organization_id = ${ctx.organizationId}`,
      );
      if (!m)
        throw validationError('That milestone isn’t on this matter', [
          { path: `items.${i}.feeMilestoneId`, message: 'Unknown milestone' },
        ]);
      if (m.status !== 'planned' && m.invoice_id !== invoiceId) {
        throw validationError('That milestone is already invoiced, waived or cancelled', [
          { path: `items.${i}.feeMilestoneId`, message: 'Not billable' },
        ]);
      }
    }
    if (it.expenseId) {
      const e = await queryOne<{ status: string; billable: boolean; billed_in: string | null }>(
        db,
        sql`SELECT e.status, e.billable_to_client AS billable,
                   (SELECT ii.invoice_id FROM invoice_items ii WHERE ii.expense_id = e.id) AS billed_in
            FROM expenses e WHERE e.id = ${it.expenseId} AND e.matter_id = ${matterId} AND e.organization_id = ${ctx.organizationId}`,
      );
      if (!e)
        throw validationError('That expense isn’t on this matter', [
          { path: `items.${i}.expenseId`, message: 'Unknown expense' },
        ]);
      if (e.status !== 'recorded' || !e.billable || (e.billed_in && e.billed_in !== invoiceId)) {
        throw validationError('That expense is void, not billable, or already on another invoice', [
          { path: `items.${i}.expenseId`, message: 'Not billable' },
        ]);
      }
    }
  }

  const placeOfSupply =
    taxMode === 'gst' ? (input.placeOfSupply ?? client.state_code ?? org.state_code) : null;
  // D-010: default reverse charge for business clients with a GSTIN; editable per invoice, CA to confirm.
  const isReverseCharge =
    taxMode === 'gst'
      ? (input.isReverseCharge ?? (client.client_type === 'company' && Boolean(client.gstin)))
      : false;
  let totals;
  try {
    totals = computeInvoiceTotals({
      taxMode,
      lines: items.map((it) => ({
        quantity: it.quantity,
        unitPrice: it.unitPrice,
        gstRate: it.gstRate,
        isPureAgent: it.isPureAgent,
      })),
      discount: input.discountAmount,
      simpleTax: input.taxAmount,
      intraState: placeOfSupply !== null && placeOfSupply === org.state_code,
      isReverseCharge,
    });
  } catch (err) {
    if (err instanceof InvoiceCalcError)
      throw validationError(err.message, [{ path: err.field, message: err.message }]);
    throw validationError((err as Error).message);
  }
  return { items, totals, placeOfSupply, isReverseCharge };
}

async function writeItems(
  db: Db,
  ctx: TenantContext,
  invoiceId: string,
  items: Item[],
  lineAmounts: number[],
) {
  await query(db, sql`DELETE FROM invoice_items WHERE invoice_id = ${invoiceId}`);
  for (const [i, it] of items.entries()) {
    await query(
      db,
      sql`INSERT INTO invoice_items (organization_id, invoice_id, position, description, quantity, unit_price, amount,
                                     sac_code, gst_rate, is_pure_agent, fee_milestone_id, expense_id)
          VALUES (${ctx.organizationId}, ${invoiceId}, ${i}, ${it.description}, ${it.quantity}, ${it.unitPrice},
                  ${fromPaise(lineAmounts[i]!)}, ${it.sacCode ?? null}, ${it.gstRate ?? null}, ${it.isPureAgent},
                  ${it.feeMilestoneId ?? null}, ${it.expenseId ?? null})`,
    );
  }
}

const totalsColumns = (t: ReturnType<typeof computeInvoiceTotals>) => sql`
  subtotal = ${fromPaise(t.subtotal)}, discount_amount = ${fromPaise(t.discount)}, cgst_amount = ${fromPaise(t.cgst)},
  sgst_amount = ${fromPaise(t.sgst)}, igst_amount = ${fromPaise(t.igst)}, rcm_tax_amount = ${fromPaise(t.rcmTax)},
  tax_amount = ${fromPaise(t.tax)}, total_amount = ${fromPaise(t.total)}`;

async function loadMatterClient(db: Db, ctx: TenantContext, matterId: string) {
  await assertMatterVisible(db, ctx, matterId);
  return (await queryOne<{
    client_id: string;
    status: string;
    state_code: string | null;
    gstin: string | null;
    client_type: string;
    client_status: string;
  }>(
    db,
    sql`SELECT m.client_id, m.status, c.state_code, c.gstin, c.client_type, c.status AS client_status
        FROM matters m JOIN clients c ON c.id = m.client_id WHERE m.id = ${matterId}`,
  ))!;
}

export async function createInvoice(
  deps: Deps,
  ctx: TenantContext,
  input: z.output<typeof createInvoiceSchema>,
  meta: RequestMeta,
): Promise<InvoiceDetailDto> {
  return withTransaction(deps.pool, async (tx) => {
    const mc = await loadMatterClient(tx, ctx, input.matterId);
    if (mc.client_status === 'archived') throw conflict('This client is archived');
    const org = await loadOrgTax(tx, ctx.organizationId);
    const { items, totals, placeOfSupply, isReverseCharge } = await prepareDraft(
      tx,
      ctx,
      input.matterId,
      org.tax_mode,
      input,
      org,
      mc,
      null,
    );
    // A placeholder total satisfies the CHECK; real totals are written just below with the items.
    const row = await queryOne<{ id: string }>(
      tx,
      sql`INSERT INTO invoices (organization_id, client_id, matter_id, tax_mode, place_of_supply, is_reverse_charge,
                                issue_date, due_date, notes, created_by)
          VALUES (${ctx.organizationId}, ${mc.client_id}, ${input.matterId}, ${org.tax_mode}, ${placeOfSupply},
                  ${isReverseCharge}, ${input.issueDate ?? null}, ${input.dueDate ?? null}, ${input.notes ?? null}, ${ctx.userId})
          RETURNING id`,
    );
    const id = row!.id;
    await writeItems(tx, ctx, id, items, totals.lineAmounts);
    await query(tx, sql`UPDATE invoices SET ${totalsColumns(totals)} WHERE id = ${id}`);
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'invoice.draft_created',
      entityType: 'invoice',
      entityId: id,
      after: { ...input, totals: { total: fromPaise(totals.total) } },
      meta,
    });
    if (input.issue)
      await issueInTx(
        tx,
        ctx,
        id,
        { issueDate: input.issueDate ?? undefined, dueDate: input.dueDate ?? undefined },
        meta,
      );
    return getInvoice(tx, ctx, id);
  });
}

async function lockInvoice(db: Db, ctx: TenantContext, id: string) {
  const row = await queryOne<{
    id: string;
    status: InvoiceStatus;
    matter_id: string;
    client_id: string;
    tax_mode: 'simple' | 'gst';
    invoice_number: string | null;
    total_amount: string;
    tax_amount: string;
    issue_date: string | null;
    due_date: string | null;
    place_of_supply: string | null;
    is_reverse_charge: boolean;
  }>(
    db,
    sql`SELECT i.id, i.status, i.matter_id, i.client_id, i.tax_mode, i.invoice_number, i.total_amount::text,
               i.tax_amount::text, i.issue_date::text, i.due_date::text, i.place_of_supply, i.is_reverse_charge
        FROM invoices i
        WHERE i.id = ${id} AND i.organization_id = ${ctx.organizationId} AND ${invoiceVisible(ctx)}
        FOR UPDATE OF i`,
  );
  if (!row) throw notFound('Invoice');
  return row;
}

export async function updateDraft(
  deps: Deps,
  ctx: TenantContext,
  id: string,
  input: z.output<typeof updateInvoiceSchema>,
  meta: RequestMeta,
): Promise<InvoiceDetailDto> {
  return withTransaction(deps.pool, async (tx) => {
    const inv = await lockInvoice(tx, ctx, id);
    if (inv.status !== 'draft')
      throw conflict('Issued invoices can’t be edited. Use a credit note or void it.');
    const mc = await loadMatterClient(tx, ctx, inv.matter_id);
    const org = await loadOrgTax(tx, ctx.organizationId);
    const { items, totals, placeOfSupply, isReverseCharge } = await prepareDraft(
      tx,
      ctx,
      inv.matter_id,
      inv.tax_mode,
      input,
      org,
      mc,
      id,
    );
    await writeItems(tx, ctx, id, items, totals.lineAmounts);
    await query(
      tx,
      sql`UPDATE invoices SET ${totalsColumns(totals)}, place_of_supply = ${placeOfSupply}, is_reverse_charge = ${isReverseCharge},
            issue_date = ${input.issueDate ?? null}, due_date = ${input.dueDate ?? null}, notes = ${input.notes ?? null}
          WHERE id = ${id}`,
    );
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'invoice.draft_updated',
      entityType: 'invoice',
      entityId: id,
      before: { total: inv.total_amount },
      after: { total: fromPaise(totals.total) },
      meta,
    });
    return getInvoice(tx, ctx, id);
  });
}

export async function deleteDraft(
  deps: Deps,
  ctx: TenantContext,
  id: string,
  meta: RequestMeta,
): Promise<void> {
  await withTransaction(deps.pool, async (tx) => {
    const inv = await lockInvoice(tx, ctx, id);
    if (inv.status !== 'draft') throw conflict('Only drafts can be deleted. Void an issued invoice instead.');
    await query(tx, sql`DELETE FROM invoices WHERE id = ${id}`);
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'invoice.draft_deleted',
      entityType: 'invoice',
      entityId: id,
      before: { total: inv.total_amount },
      meta,
    });
  });
}

// ---------------------------------------------------------------------------
// Issue / void / write-off / credit note
// ---------------------------------------------------------------------------

async function issueInTx(
  db: Db,
  ctx: TenantContext,
  id: string,
  dates: { issueDate?: string | undefined; dueDate?: string | undefined },
  meta: RequestMeta,
): Promise<void> {
  const inv = await lockInvoice(db, ctx, id);
  if (inv.status !== 'draft') throw conflict('This invoice was already issued');
  const org = await loadOrgTax(db, ctx.organizationId);
  if (inv.tax_mode === 'gst' && (!org.gstin || !org.state_code)) {
    throw validationError(
      'Add your firm’s GSTIN and state code in Firm settings before issuing GST invoices',
      [{ path: 'gstin', message: 'Missing firm GSTIN' }],
    );
  }
  const today = await orgToday(db, ctx.organizationId);
  const issueDate = dates.issueDate ?? inv.issue_date ?? today;
  const terms = Number(org.settings?.paymentTermsDays ?? DEFAULT_PAYMENT_TERMS_DAYS);
  const dueDate =
    dates.dueDate ??
    inv.due_date ??
    (await queryOne<{ d: string }>(db, sql`SELECT (${issueDate}::date + ${terms}::int)::text AS d`))!.d;
  if (dueDate < issueDate)
    throw validationError('Due date cannot be before the issue date', [
      { path: 'dueDate', message: 'Before issue date' },
    ]);

  // Recompute with the firm's current state/GSTIN (it may have changed since drafting).
  const mc = await loadMatterClient(db, ctx, inv.matter_id);
  const items = await query<{
    quantity: string;
    unit_price: string;
    gst_rate: string | null;
    is_pure_agent: boolean;
    fee_milestone_id: string | null;
    expense_id: string | null;
    description: string;
    sac_code: string | null;
  }>(
    db,
    sql`SELECT quantity::text, unit_price::text, gst_rate::text, is_pure_agent, fee_milestone_id, expense_id, description, sac_code
        FROM invoice_items WHERE invoice_id = ${id} ORDER BY position`,
  );
  if (items.length === 0)
    throw validationError('Add at least one item before issuing', [{ path: 'items', message: 'No items' }]);
  const discount = (await queryOne<{ d: string; t: string }>(
    db,
    sql`SELECT discount_amount::text AS d, tax_amount::text AS t FROM invoices WHERE id = ${id}`,
  ))!;
  const totals = computeInvoiceTotals({
    taxMode: inv.tax_mode,
    lines: items.map((l) => ({
      quantity: l.quantity,
      unitPrice: l.unit_price,
      gstRate: l.gst_rate,
      isPureAgent: l.is_pure_agent,
    })),
    discount: discount.d,
    simpleTax: discount.t,
    intraState: inv.place_of_supply !== null && inv.place_of_supply === org.state_code,
    isReverseCharge: inv.is_reverse_charge,
  });

  // Lock and re-check linked milestones/expenses at the moment of issue.
  for (const l of items) {
    if (l.fee_milestone_id) {
      const ok = await queryOne(
        db,
        sql`SELECT 1 FROM fee_milestones WHERE id = ${l.fee_milestone_id} AND status = 'planned' FOR UPDATE`,
      );
      if (!ok) throw conflict(`Milestone on “${l.description}” is no longer billable`);
    }
    if (l.expense_id) {
      const ok = await queryOne(
        db,
        sql`SELECT 1 FROM expenses WHERE id = ${l.expense_id} AND status = 'recorded' FOR UPDATE`,
      );
      if (!ok) throw conflict(`Expense on “${l.description}” is no longer billable`);
    }
  }

  const { number, fiscalYear } = await nextDocumentNumber(
    db,
    ctx.organizationId,
    'invoice',
    issueDate,
    org.invoice_prefix,
  );
  await query(
    db,
    sql`UPDATE invoices SET ${totalsColumns(totals)}, status = 'issued', invoice_number = ${number}, fiscal_year = ${fiscalYear},
          issue_date = ${issueDate}, due_date = ${dueDate}, issued_at = now(), issued_by = ${ctx.userId},
          supplier_gstin = ${inv.tax_mode === 'gst' ? org.gstin : null},
          supplier_state_code = ${inv.tax_mode === 'gst' ? org.state_code : null},
          recipient_gstin = ${inv.tax_mode === 'gst' ? mc.gstin : null},
          recipient_state_code = ${inv.tax_mode === 'gst' ? mc.state_code : null}
        WHERE id = ${id}`,
  );
  for (const l of items) {
    if (l.fee_milestone_id)
      await query(
        db,
        sql`UPDATE fee_milestones SET status = 'invoiced', invoice_id = ${id} WHERE id = ${l.fee_milestone_id}`,
      );
    if (l.expense_id) await query(db, sql`UPDATE expenses SET status = 'billed' WHERE id = ${l.expense_id}`);
  }

  const base = { matterId: inv.matter_id, clientId: inv.client_id, invoiceId: id };
  await postLedger(db, ctx.organizationId, ctx.userId, [
    {
      ...base,
      entryType: 'invoice_issued',
      debit: 'accounts_receivable',
      credit: 'fee_revenue',
      amountPaise: totals.total - totals.tax,
    },
    {
      ...base,
      entryType: 'invoice_issued',
      debit: 'accounts_receivable',
      credit: 'gst_output',
      amountPaise: totals.tax,
    },
  ]);
  await addTimelineEvent(db, {
    organizationId: ctx.organizationId,
    matterId: inv.matter_id,
    clientId: inv.client_id,
    eventType: 'invoice.issued',
    title: `Invoice ${number} issued: ${rupees(totals.total)}`,
    description: `Due ${displayDate(dueDate)}${inv.is_reverse_charge ? ' · GST payable by client (reverse charge)' : ''}`,
    actorUserId: ctx.userId,
    sourceType: 'invoice',
    sourceId: id,
  });
  // PRD event name: INVOICE_CREATED triggers the invoice email (Phase 5 workflow).
  await emitEvent(db, {
    organizationId: ctx.organizationId,
    eventType: 'INVOICE_CREATED',
    aggregateType: 'invoice',
    aggregateId: id,
    payload: {
      invoiceId: id,
      invoiceNumber: number,
      matterId: inv.matter_id,
      clientId: inv.client_id,
      total: fromPaise(totals.total),
      dueDate,
    },
    actorUserId: ctx.userId,
  });
  await recordAudit(db, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'invoice.issued',
    entityType: 'invoice',
    entityId: id,
    after: {
      invoiceNumber: number,
      issueDate,
      dueDate,
      total: fromPaise(totals.total),
      tax: fromPaise(totals.tax),
    },
    meta,
  });
}

export async function issueInvoice(
  deps: Deps,
  ctx: TenantContext,
  id: string,
  dates: { issueDate?: string | undefined; dueDate?: string | undefined },
  meta: RequestMeta,
): Promise<InvoiceDetailDto> {
  return withTransaction(deps.pool, async (tx) => {
    await issueInTx(tx, ctx, id, dates, meta);
    return getInvoice(tx, ctx, id);
  });
}

export async function voidInvoice(
  deps: Deps,
  ctx: TenantContext,
  id: string,
  reason: string,
  meta: RequestMeta,
) {
  return withTransaction(deps.pool, async (tx) => {
    const inv = await lockInvoice(tx, ctx, id);
    if (inv.status !== 'issued')
      throw conflict(
        inv.status === 'draft'
          ? 'Delete a draft instead of voiding it'
          : `This invoice is already ${inv.status.replace('_', ' ')}`,
      );
    const settled = await queryOne<{ n: number }>(
      tx,
      sql`SELECT (SELECT count(*) FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
                   WHERE a.invoice_id = ${id} AND a.status = 'active' AND p.status = 'posted')
               + (SELECT count(*) FROM credit_notes WHERE invoice_id = ${id}) AS n`,
    );
    if (Number(settled!.n) > 0) {
      throw new AppError(
        409,
        'CONFLICT',
        'Payments or credit notes are applied to this invoice. Reverse or un-apply them first.',
      );
    }
    await query(
      tx,
      sql`UPDATE invoices SET status = 'void', voided_at = now(), voided_by = ${ctx.userId}, void_reason = ${reason} WHERE id = ${id}`,
    );
    await query(
      tx,
      sql`UPDATE fee_milestones SET status = 'planned', invoice_id = NULL WHERE invoice_id = ${id}`,
    );
    await query(
      tx,
      sql`UPDATE expenses SET status = 'recorded' WHERE id IN (SELECT expense_id FROM invoice_items WHERE invoice_id = ${id} AND expense_id IS NOT NULL)`,
    );
    const total = toPaise(inv.total_amount);
    const tax = toPaise(inv.tax_amount);
    const base = { matterId: inv.matter_id, clientId: inv.client_id, invoiceId: id };
    await postLedger(tx, ctx.organizationId, ctx.userId, [
      {
        ...base,
        entryType: 'invoice_voided',
        debit: 'fee_revenue',
        credit: 'accounts_receivable',
        amountPaise: total - tax,
      },
      {
        ...base,
        entryType: 'invoice_voided',
        debit: 'gst_output',
        credit: 'accounts_receivable',
        amountPaise: tax,
      },
    ]);
    await addTimelineEvent(tx, {
      organizationId: ctx.organizationId,
      matterId: inv.matter_id,
      clientId: inv.client_id,
      eventType: 'invoice.voided',
      title: `Invoice ${inv.invoice_number} voided`,
      description: reason,
      actorUserId: ctx.userId,
      sourceType: 'invoice',
      sourceId: id,
    });
    await emitEvent(tx, {
      organizationId: ctx.organizationId,
      eventType: 'INVOICE_VOIDED',
      aggregateType: 'invoice',
      aggregateId: id,
      payload: { invoiceId: id, matterId: inv.matter_id, reason },
      actorUserId: ctx.userId,
    });
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'invoice.voided',
      entityType: 'invoice',
      entityId: id,
      before: { status: 'issued' },
      after: { status: 'void', reason },
      meta,
    });
    return getInvoice(tx, ctx, id);
  });
}

export async function writeOffInvoice(
  deps: Deps,
  ctx: TenantContext,
  id: string,
  reason: string,
  meta: RequestMeta,
) {
  return withTransaction(deps.pool, async (tx) => {
    const inv = await lockInvoice(tx, ctx, id);
    if (inv.status !== 'issued') throw conflict('Only an issued invoice can be written off');
    const due = toPaise(
      (await queryOne<{ d: string }>(
        tx,
        sql`SELECT amount_due::text AS d FROM v_invoice_balances WHERE invoice_id = ${id}`,
      ))!.d,
    );
    if (due <= 0) throw conflict('Nothing is outstanding on this invoice');
    await query(
      tx,
      sql`UPDATE invoices SET status = 'written_off', written_off_at = now(), written_off_by = ${ctx.userId}, write_off_reason = ${reason} WHERE id = ${id}`,
    );
    await postLedger(tx, ctx.organizationId, ctx.userId, [
      {
        matterId: inv.matter_id,
        clientId: inv.client_id,
        invoiceId: id,
        entryType: 'invoice_written_off',
        debit: 'bad_debt',
        credit: 'accounts_receivable',
        amountPaise: due,
      },
    ]);
    await addTimelineEvent(tx, {
      organizationId: ctx.organizationId,
      matterId: inv.matter_id,
      clientId: inv.client_id,
      eventType: 'invoice.written_off',
      title: `Invoice ${inv.invoice_number}: ${rupees(due)} written off`,
      description: reason,
      actorUserId: ctx.userId,
      sourceType: 'invoice',
      sourceId: id,
    });
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'invoice.written_off',
      entityType: 'invoice',
      entityId: id,
      after: { amount: fromPaise(due), reason },
      meta,
    });
    return getInvoice(tx, ctx, id);
  });
}

export async function issueCreditNote(
  deps: Deps,
  ctx: TenantContext,
  id: string,
  input: z.output<typeof creditNoteSchema>,
  meta: RequestMeta,
) {
  return withTransaction(deps.pool, async (tx) => {
    const inv = await lockInvoice(tx, ctx, id);
    if (inv.status !== 'issued') throw conflict('Credit notes apply to issued invoices only');
    const due = toPaise(
      (await queryOne<{ d: string }>(
        tx,
        sql`SELECT amount_due::text AS d FROM v_invoice_balances WHERE invoice_id = ${id}`,
      ))!.d,
    );
    const amount = toPaise(input.amount);
    if (amount > due)
      throw validationError(`Credit can’t exceed the amount due (${rupees(due)})`, [
        { path: 'amount', message: 'More than due' },
      ]);
    const issueDate = input.issueDate ?? (await orgToday(tx, ctx.organizationId));
    if (inv.issue_date && issueDate < inv.issue_date)
      throw validationError('Credit note can’t predate the invoice', [
        { path: 'issueDate', message: 'Before invoice date' },
      ]);
    const { number, fiscalYear } = await nextDocumentNumber(
      tx,
      ctx.organizationId,
      'credit_note',
      issueDate,
      CREDIT_NOTE_PREFIX,
    );
    // Tax share of the credit, proportional to the invoice's tax (for GST reporting).
    const total = toPaise(inv.total_amount);
    const taxShare = total > 0 ? Math.round((amount * toPaise(inv.tax_amount)) / total) : 0;
    const cn = await queryOne<{ id: string }>(
      tx,
      sql`INSERT INTO credit_notes (organization_id, invoice_id, credit_note_number, fiscal_year, issue_date, amount, tax_amount, reason, created_by)
          VALUES (${ctx.organizationId}, ${id}, ${number}, ${fiscalYear}, ${issueDate}, ${input.amount}, ${fromPaise(taxShare)}, ${input.reason}, ${ctx.userId})
          RETURNING id`,
    );
    const base = { matterId: inv.matter_id, clientId: inv.client_id, invoiceId: id, creditNoteId: cn!.id };
    await postLedger(tx, ctx.organizationId, ctx.userId, [
      {
        ...base,
        entryType: 'credit_note_issued',
        debit: 'fee_revenue',
        credit: 'accounts_receivable',
        amountPaise: amount - taxShare,
      },
      {
        ...base,
        entryType: 'credit_note_issued',
        debit: 'gst_output',
        credit: 'accounts_receivable',
        amountPaise: taxShare,
      },
    ]);
    await addTimelineEvent(tx, {
      organizationId: ctx.organizationId,
      matterId: inv.matter_id,
      clientId: inv.client_id,
      eventType: 'invoice.credit_note',
      title: `Credit note ${number}: ${rupees(amount)} against ${inv.invoice_number}`,
      description: input.reason,
      actorUserId: ctx.userId,
      sourceType: 'invoice',
      sourceId: id,
    });
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'invoice.credit_note_issued',
      entityType: 'invoice',
      entityId: id,
      after: { number, amount: input.amount, reason: input.reason },
      meta,
    });
    return getInvoice(tx, ctx, id);
  });
}
