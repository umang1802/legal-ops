import { PAYMENT_METHOD_LABELS, type PaymentDto, type PaymentMethod } from '@legalops/types';
import {
  fiscalYear,
  fromPaise,
  toPaise,
  type listPaymentsSchema,
  type recordPaymentSchema,
} from '@legalops/validation';
import type { z } from 'zod';
import { query, queryOne, withTransaction, type Db } from '../../db/pool.js';
import { sql, type SqlFragment } from '../../db/sql.js';
import type { Deps } from '../../deps.js';
import type { RequestMeta, TenantContext } from '../../http/context.js';
import { conflict, notFound, validationError } from '../../http/errors.js';
import { iso, pageClause } from '../../http/query-helpers.js';
import { assertMatterVisible } from '../access/matter-scope.js';
import { recordAudit } from '../audit/audit.service.js';
import { emitEvent } from '../outbox/outbox.service.js';
import { addTimelineEvent } from '../timeline/timeline.service.js';
import { rupees } from './invoices.service.js';
import { postLedger } from './ledger.js';
import { nextDocumentNumber, RECEIPT_PREFIX } from './numbering.js';
import { invoiceVisible, paymentVisible } from './visibility.js';

type PaymentRow = {
  id: string;
  receipt_number: string;
  client_id: string;
  client_name: string;
  matter_id: string | null;
  matter_title: string | null;
  amount: string;
  tds_amount: string;
  unallocated: string;
  payment_date: string;
  payment_method: PaymentMethod;
  reference_number: string | null;
  notes: string | null;
  status: 'posted' | 'reversed';
  recorded_by: string | null;
  first_name: string | null;
  last_name: string | null;
  reversed_at: Date | null;
  reversal_reason: string | null;
  tds_certificate_number: string | null;
  tds_certificate_received_at: string | null;
  created_at: Date;
};

const PAYMENT_SELECT = sql`
  p.id, p.receipt_number, p.client_id, c.name AS client_name, p.matter_id, m.title AS matter_title,
  p.amount::text, p.tds_amount::text,
  CASE WHEN p.status = 'posted'
       THEN (p.amount + p.tds_amount - COALESCE((SELECT sum(a.amount) FROM payment_allocations a
                                                 WHERE a.payment_id = p.id AND a.status = 'active'), 0))
       ELSE 0 END::numeric(14,2)::text AS unallocated,
  p.payment_date::text, p.payment_method, p.reference_number, p.notes, p.status, p.recorded_by,
  u.first_name, u.last_name, p.reversed_at, p.reversal_reason, p.tds_certificate_number,
  p.tds_certificate_received_at::text, p.created_at`;

const PAYMENT_FROM = sql`
  payments p
  JOIN clients c ON c.id = p.client_id
  LEFT JOIN matters m ON m.id = p.matter_id
  LEFT JOIN users u ON u.id = p.recorded_by`;

async function hydrate(db: Db, rows: PaymentRow[]): Promise<PaymentDto[]> {
  if (rows.length === 0) return [];
  const allocs = await query<{
    id: string;
    payment_id: string;
    invoice_id: string;
    invoice_number: string | null;
    amount: string;
    active: boolean;
    created_at: Date;
  }>(
    db,
    sql`SELECT a.id, a.payment_id, a.invoice_id, i.invoice_number, a.amount::text, a.status = 'active' AS active, a.created_at
        FROM payment_allocations a JOIN invoices i ON i.id = a.invoice_id
        WHERE a.payment_id = ANY(${rows.map((r) => r.id)}::uuid[]) ORDER BY a.created_at`,
  );
  return rows.map((r) => ({
    id: r.id,
    receiptNumber: r.receipt_number,
    client: { id: r.client_id, name: r.client_name },
    matter: r.matter_id ? { id: r.matter_id, title: r.matter_title ?? '' } : null,
    amount: r.amount,
    tdsAmount: r.tds_amount,
    settlement: fromPaise(toPaise(r.amount) + toPaise(r.tds_amount)),
    unallocated: r.unallocated,
    paymentDate: r.payment_date,
    method: r.payment_method,
    referenceNumber: r.reference_number,
    notes: r.notes,
    status: r.status,
    recordedBy: r.recorded_by
      ? { userId: r.recorded_by, firstName: r.first_name ?? '', lastName: r.last_name }
      : null,
    reversedAt: iso(r.reversed_at),
    reversalReason: r.reversal_reason,
    tdsCertificateNumber: r.tds_certificate_number,
    tdsCertificateReceivedAt: r.tds_certificate_received_at,
    allocations: allocs
      .filter((a) => a.payment_id === r.id)
      .map((a) => ({
        id: a.id,
        invoiceId: a.invoice_id,
        invoiceNumber: a.invoice_number,
        amount: a.amount,
        active: a.active,
        createdAt: iso(a.created_at)!,
      })),
    createdAt: iso(r.created_at)!,
  }));
}

export async function queryPayments(
  db: Db,
  ctx: TenantContext,
  where: SqlFragment[],
  page?: { page: number; pageSize: number },
): Promise<{ items: PaymentDto[]; total: number }> {
  const rows = await query<PaymentRow & { total: number }>(
    db,
    sql`SELECT ${PAYMENT_SELECT}, count(*) OVER ()::int AS total FROM ${PAYMENT_FROM}
        WHERE ${sql.join([sql`p.organization_id = ${ctx.organizationId}`, paymentVisible(ctx), ...where], ' AND ')}
        ORDER BY p.payment_date DESC, p.created_at DESC
        ${page ? pageClause(page) : sql`LIMIT 200`}`,
  );
  return { items: await hydrate(db, rows), total: rows[0]?.total ?? 0 };
}

export async function listPayments(deps: Deps, ctx: TenantContext, f: z.output<typeof listPaymentsSchema>) {
  const where: SqlFragment[] = [];
  if (f.clientId) where.push(sql`p.client_id = ${f.clientId}`);
  if (f.matterId) {
    where.push(sql`(p.matter_id = ${f.matterId} OR EXISTS (SELECT 1 FROM payment_allocations a JOIN invoices i ON i.id = a.invoice_id
                     WHERE a.payment_id = p.id AND i.matter_id = ${f.matterId}))`);
  }
  if (f.from) where.push(sql`p.payment_date >= ${f.from}`);
  if (f.until) where.push(sql`p.payment_date <= ${f.until}`);
  if (f.status !== 'all') where.push(sql`p.status = ${f.status}`);
  return queryPayments(deps.pool, ctx, where, f);
}

export async function getPayment(db: Db, ctx: TenantContext, id: string): Promise<PaymentDto> {
  const { items } = await queryPayments(db, ctx, [sql`p.id = ${id}`]);
  if (!items[0]) throw notFound('Payment');
  return items[0];
}

/** Locks an invoice for allocation and returns its live amount due (paise). */
async function lockInvoiceForAllocation(
  db: Db,
  ctx: TenantContext,
  invoiceId: string,
  clientId: string,
  path: string,
) {
  const inv = await queryOne<{
    id: string;
    status: string;
    client_id: string;
    matter_id: string;
    invoice_number: string | null;
  }>(
    db,
    sql`SELECT i.id, i.status, i.client_id, i.matter_id, i.invoice_number FROM invoices i
        WHERE i.id = ${invoiceId} AND i.organization_id = ${ctx.organizationId} AND ${invoiceVisible(ctx)}
        FOR UPDATE OF i`,
  );
  if (!inv) throw validationError('Unknown invoice', [{ path, message: 'Unknown invoice' }]);
  if (inv.client_id !== clientId)
    throw validationError('That invoice belongs to a different client', [
      { path, message: 'Different client' },
    ]);
  if (inv.status !== 'issued')
    throw validationError(`Invoice ${inv.invoice_number ?? '(draft)'} is not open for payment`, [
      { path, message: 'Not payable' },
    ]);
  const due = toPaise(
    (await queryOne<{ d: string }>(
      db,
      sql`SELECT amount_due::text AS d FROM v_invoice_balances WHERE invoice_id = ${invoiceId}`,
    ))!.d,
  );
  return { ...inv, duePaise: due };
}

type Allocated = {
  invoiceId: string;
  matterId: string;
  invoiceNumber: string | null;
  amountPaise: number;
  dueAfterPaise: number;
};

async function allocate(
  db: Db,
  ctx: TenantContext,
  paymentId: string,
  clientId: string,
  allocations: { invoiceId: string; amount: string }[],
  availablePaise: number,
): Promise<Allocated[]> {
  // Lock in a stable order so concurrent payments on the same invoices can't deadlock.
  const ordered = [...allocations].sort((a, b) => a.invoiceId.localeCompare(b.invoiceId));
  const result: Allocated[] = [];
  let remaining = availablePaise;
  for (const a of ordered) {
    const idx = allocations.indexOf(a);
    const inv = await lockInvoiceForAllocation(
      db,
      ctx,
      a.invoiceId,
      clientId,
      `allocations.${idx}.invoiceId`,
    );
    const amount = toPaise(a.amount);
    if (amount > inv.duePaise) {
      throw validationError(`Only ${rupees(inv.duePaise)} is due on ${inv.invoice_number}`, [
        { path: `allocations.${idx}.amount`, message: `Max ${fromPaise(inv.duePaise)}` },
      ]);
    }
    if (amount > remaining) {
      throw validationError('Allocations add up to more than the payment', [
        { path: `allocations.${idx}.amount`, message: 'Exceeds payment' },
      ]);
    }
    remaining -= amount;
    await query(
      db,
      sql`INSERT INTO payment_allocations (organization_id, payment_id, invoice_id, amount, allocated_by)
          VALUES (${ctx.organizationId}, ${paymentId}, ${a.invoiceId}, ${a.amount}, ${ctx.userId})`,
    );
    result.push({
      invoiceId: inv.id,
      matterId: inv.matter_id,
      invoiceNumber: inv.invoice_number,
      amountPaise: amount,
      dueAfterPaise: inv.duePaise - amount,
    });
  }
  return result;
}

/** Ledger, timeline and events for newly applied amounts; INVOICE_PAID when an invoice is fully settled. */
async function afterAllocation(
  db: Db,
  ctx: TenantContext,
  paymentId: string,
  clientId: string,
  receipt: string,
  applied: Allocated[],
) {
  await postLedger(
    db,
    ctx.organizationId,
    ctx.userId,
    applied.map((a) => ({
      entryType: 'payment_allocated' as const,
      debit: 'client_advance' as const,
      credit: 'accounts_receivable' as const,
      amountPaise: a.amountPaise,
      matterId: a.matterId,
      clientId,
      invoiceId: a.invoiceId,
      paymentId,
    })),
  );
  for (const a of applied.filter((x) => x.dueAfterPaise === 0)) {
    await addTimelineEvent(db, {
      organizationId: ctx.organizationId,
      matterId: a.matterId,
      clientId,
      eventType: 'invoice.paid',
      title: `Invoice ${a.invoiceNumber} fully paid`,
      description: `Settled by receipt ${receipt}`,
      actorUserId: ctx.userId,
      sourceType: 'invoice',
      sourceId: a.invoiceId,
    });
    await emitEvent(db, {
      organizationId: ctx.organizationId,
      eventType: 'INVOICE_PAID',
      aggregateType: 'invoice',
      aggregateId: a.invoiceId,
      payload: { invoiceId: a.invoiceId, matterId: a.matterId, clientId, paymentId },
      actorUserId: ctx.userId,
    });
  }
}

/** Journey E (PRD §5): validate → payment → allocations → ledger → state → timeline → events, in one transaction. */
export async function recordPayment(
  deps: Deps,
  ctx: TenantContext,
  input: z.output<typeof recordPaymentSchema>,
  meta: RequestMeta,
): Promise<PaymentDto> {
  return withTransaction(deps.pool, async (tx) => {
    const client = await queryOne<{ id: string; name: string }>(
      tx,
      sql`SELECT id, name FROM clients WHERE id = ${input.clientId} AND organization_id = ${ctx.organizationId}`,
    );
    if (!client) throw validationError('Choose a client', [{ path: 'clientId', message: 'Unknown client' }]);
    if (input.matterId) {
      await assertMatterVisible(tx, ctx, input.matterId);
      const ok = await queryOne(
        tx,
        sql`SELECT 1 FROM matters WHERE id = ${input.matterId} AND client_id = ${input.clientId}`,
      );
      if (!ok)
        throw validationError('That matter belongs to another client', [
          { path: 'matterId', message: 'Different client' },
        ]);
    }

    const settlement = toPaise(input.amount) + toPaise(input.tdsAmount);
    const allocatedTotal = input.allocations.reduce((s, a) => s + toPaise(a.amount), 0);
    if (allocatedTotal > settlement) {
      throw validationError('Allocations add up to more than the payment', [
        { path: 'allocations', message: 'Exceeds payment' },
      ]);
    }
    const remainder = settlement - allocatedTotal;
    if (remainder > 0 && !input.keepRemainderAsAdvance) {
      // PRD Screen 18: prevent accidental overpayment by default.
      throw validationError(
        `${rupees(remainder)} isn’t applied to any invoice. Apply it, or keep it as an advance.`,
        [{ path: 'keepRemainderAsAdvance', message: 'Unapplied amount' }],
      );
    }

    const { number } = await nextDocumentNumber(
      tx,
      ctx.organizationId,
      'receipt',
      input.paymentDate,
      RECEIPT_PREFIX,
    );
    const row = await queryOne<{ id: string }>(
      tx,
      sql`INSERT INTO payments (organization_id, client_id, matter_id, receipt_number, amount, tds_amount, payment_date,
                                payment_method, reference_number, notes, recorded_by)
          VALUES (${ctx.organizationId}, ${input.clientId}, ${input.matterId ?? null}, ${number}, ${input.amount},
                  ${input.tdsAmount}, ${input.paymentDate}, ${input.method}, ${input.referenceNumber ?? null},
                  ${input.notes ?? null}, ${ctx.userId})
          RETURNING id`,
    );
    const paymentId = row!.id;
    await postLedger(tx, ctx.organizationId, ctx.userId, [
      {
        entryType: 'payment_received',
        debit: 'cash_bank',
        credit: 'client_advance',
        amountPaise: toPaise(input.amount),
        clientId: input.clientId,
        matterId: input.matterId ?? null,
        paymentId,
      },
      {
        entryType: 'payment_received',
        debit: 'tds_receivable',
        credit: 'client_advance',
        amountPaise: toPaise(input.tdsAmount),
        clientId: input.clientId,
        matterId: input.matterId ?? null,
        paymentId,
      },
    ]);
    const applied = await allocate(tx, ctx, paymentId, input.clientId, input.allocations, settlement);

    // Timeline on each matter the money touched (and the payment's own matter).
    const matters = new Map<string, Allocated[]>();
    for (const a of applied) matters.set(a.matterId, [...(matters.get(a.matterId) ?? []), a]);
    if (input.matterId && !matters.has(input.matterId)) matters.set(input.matterId, []);
    for (const [matterId, list] of matters) {
      await addTimelineEvent(tx, {
        organizationId: ctx.organizationId,
        matterId,
        clientId: input.clientId,
        eventType: 'payment.received',
        title: `Payment received: ${rupees(toPaise(input.amount))} (${PAYMENT_METHOD_LABELS[input.method]})`,
        description: [
          toPaise(input.tdsAmount) > 0 ? `+ ${rupees(toPaise(input.tdsAmount))} TDS` : null,
          list.length ? `Applied to ${list.map((a) => a.invoiceNumber).join(', ')}` : 'Held as advance',
          `Receipt ${number}`,
        ]
          .filter(Boolean)
          .join(' · '),
        actorUserId: ctx.userId,
        sourceType: 'payment',
        sourceId: paymentId,
      });
    }
    await emitEvent(tx, {
      organizationId: ctx.organizationId,
      eventType: 'PAYMENT_RECEIVED',
      aggregateType: 'payment',
      aggregateId: paymentId,
      payload: {
        paymentId,
        clientId: input.clientId,
        amount: input.amount,
        tdsAmount: input.tdsAmount,
        receiptNumber: number,
        invoiceIds: applied.map((a) => a.invoiceId),
      },
      actorUserId: ctx.userId,
    });
    await afterAllocation(tx, ctx, paymentId, input.clientId, number, applied);
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'payment.recorded',
      entityType: 'payment',
      entityId: paymentId,
      after: { ...input, receiptNumber: number, fiscalYear: fiscalYear(input.paymentDate) },
      meta,
    });
    return getPayment(tx, ctx, paymentId);
  });
}

async function lockPayment(db: Db, ctx: TenantContext, id: string) {
  const p = await queryOne<{
    id: string;
    status: string;
    client_id: string;
    matter_id: string | null;
    amount: string;
    tds_amount: string;
    receipt_number: string;
  }>(
    db,
    sql`SELECT p.id, p.status, p.client_id, p.matter_id, p.amount::text, p.tds_amount::text, p.receipt_number
        FROM payments p WHERE p.id = ${id} AND p.organization_id = ${ctx.organizationId} AND ${paymentVisible(ctx)}
        FOR UPDATE OF p`,
  );
  if (!p) throw notFound('Payment');
  return p;
}

/** Applies an unallocated advance to an invoice later. */
export async function allocateAdvance(
  deps: Deps,
  ctx: TenantContext,
  paymentId: string,
  input: { invoiceId: string; amount: string },
  meta: RequestMeta,
): Promise<PaymentDto> {
  return withTransaction(deps.pool, async (tx) => {
    const p = await lockPayment(tx, ctx, paymentId);
    if (p.status !== 'posted') throw conflict('A reversed payment can’t be applied');
    const used = toPaise(
      (await queryOne<{ s: string }>(
        tx,
        sql`SELECT COALESCE(sum(amount), 0)::text AS s FROM payment_allocations WHERE payment_id = ${paymentId} AND status = 'active'`,
      ))!.s,
    );
    const available = toPaise(p.amount) + toPaise(p.tds_amount) - used;
    if (toPaise(input.amount) > available) {
      throw validationError(`Only ${rupees(available)} of this payment is unapplied`, [
        { path: 'amount', message: `Max ${fromPaise(available)}` },
      ]);
    }
    const applied = await allocate(tx, ctx, paymentId, p.client_id, [input], available);
    for (const a of applied) {
      await addTimelineEvent(tx, {
        organizationId: ctx.organizationId,
        matterId: a.matterId,
        clientId: p.client_id,
        eventType: 'payment.applied',
        title: `Advance applied: ${rupees(a.amountPaise)} to ${a.invoiceNumber}`,
        description: `From receipt ${p.receipt_number}`,
        actorUserId: ctx.userId,
        sourceType: 'payment',
        sourceId: paymentId,
      });
    }
    await afterAllocation(tx, ctx, paymentId, p.client_id, p.receipt_number, applied);
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'payment.allocated',
      entityType: 'payment',
      entityId: paymentId,
      after: input,
      meta,
    });
    return getPayment(tx, ctx, paymentId);
  });
}

async function reverseAllocations(
  db: Db,
  ctx: TenantContext,
  paymentId: string,
  clientId: string,
  reason: string,
  onlyAllocationId?: string,
) {
  const rows = await query<{
    id: string;
    invoice_id: string;
    amount: string;
    matter_id: string;
    invoice_number: string | null;
  }>(
    db,
    sql`UPDATE payment_allocations a SET status = 'reversed', reversed_at = now(), reversed_by = ${ctx.userId}, reversal_reason = ${reason}
        FROM invoices i
        WHERE a.payment_id = ${paymentId} AND a.status = 'active' AND i.id = a.invoice_id
          ${onlyAllocationId ? sql`AND a.id = ${onlyAllocationId}` : sql.empty}
        RETURNING a.id, a.invoice_id, a.amount::text, i.matter_id, i.invoice_number`,
  );
  await postLedger(
    db,
    ctx.organizationId,
    ctx.userId,
    rows.map((r) => ({
      entryType: 'allocation_reversed' as const,
      debit: 'accounts_receivable' as const,
      credit: 'client_advance' as const,
      amountPaise: toPaise(r.amount),
      matterId: r.matter_id,
      clientId,
      invoiceId: r.invoice_id,
      paymentId,
    })),
  );
  return rows;
}

/** Corrections are reversals, never edits (PRD §7.4). Restores every invoice it had settled. */
export async function reversePayment(
  deps: Deps,
  ctx: TenantContext,
  id: string,
  reason: string,
  meta: RequestMeta,
): Promise<PaymentDto> {
  return withTransaction(deps.pool, async (tx) => {
    const p = await lockPayment(tx, ctx, id);
    if (p.status !== 'posted') throw conflict('This payment is already reversed');
    const reversed = await reverseAllocations(tx, ctx, id, p.client_id, reason);
    await query(
      tx,
      sql`UPDATE payments SET status = 'reversed', reversed_at = now(), reversed_by = ${ctx.userId}, reversal_reason = ${reason} WHERE id = ${id}`,
    );
    await postLedger(tx, ctx.organizationId, ctx.userId, [
      {
        entryType: 'payment_reversed',
        debit: 'client_advance',
        credit: 'cash_bank',
        amountPaise: toPaise(p.amount),
        clientId: p.client_id,
        matterId: p.matter_id,
        paymentId: id,
      },
      {
        entryType: 'payment_reversed',
        debit: 'client_advance',
        credit: 'tds_receivable',
        amountPaise: toPaise(p.tds_amount),
        clientId: p.client_id,
        matterId: p.matter_id,
        paymentId: id,
      },
    ]);
    const matters = new Set([...reversed.map((r) => r.matter_id), ...(p.matter_id ? [p.matter_id] : [])]);
    for (const matterId of matters) {
      await addTimelineEvent(tx, {
        organizationId: ctx.organizationId,
        matterId,
        clientId: p.client_id,
        eventType: 'payment.reversed',
        title: `Payment reversed: receipt ${p.receipt_number} (${rupees(toPaise(p.amount))})`,
        description: reason,
        actorUserId: ctx.userId,
        sourceType: 'payment',
        sourceId: id,
      });
    }
    await emitEvent(tx, {
      organizationId: ctx.organizationId,
      eventType: 'PAYMENT_REVERSED',
      aggregateType: 'payment',
      aggregateId: id,
      payload: {
        paymentId: id,
        clientId: p.client_id,
        invoiceIds: reversed.map((r) => r.invoice_id),
        reason,
      },
      actorUserId: ctx.userId,
    });
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'payment.reversed',
      entityType: 'payment',
      entityId: id,
      before: { status: 'posted' },
      after: { status: 'reversed', reason },
      meta,
    });
    return getPayment(tx, ctx, id);
  });
}

/** Un-applies one allocation (e.g. applied to the wrong invoice); the money returns to the client's advance. */
export async function reverseAllocation(
  deps: Deps,
  ctx: TenantContext,
  paymentId: string,
  allocationId: string,
  reason: string,
  meta: RequestMeta,
): Promise<PaymentDto> {
  return withTransaction(deps.pool, async (tx) => {
    const p = await lockPayment(tx, ctx, paymentId);
    if (p.status !== 'posted') throw conflict('This payment is reversed');
    const rows = await reverseAllocations(tx, ctx, paymentId, p.client_id, reason, allocationId);
    if (rows.length === 0) throw notFound('Allocation');
    const r = rows[0]!;
    await addTimelineEvent(tx, {
      organizationId: ctx.organizationId,
      matterId: r.matter_id,
      clientId: p.client_id,
      eventType: 'payment.unapplied',
      title: `${rupees(toPaise(r.amount))} un-applied from ${r.invoice_number}`,
      description: `${reason} · now held as advance on receipt ${p.receipt_number}`,
      actorUserId: ctx.userId,
      sourceType: 'payment',
      sourceId: paymentId,
    });
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'payment.allocation_reversed',
      entityType: 'payment',
      entityId: paymentId,
      after: { allocationId, reason },
      meta,
    });
    return getPayment(tx, ctx, paymentId);
  });
}

export async function recordTdsCertificate(
  deps: Deps,
  ctx: TenantContext,
  id: string,
  input: { certificateNumber: string; receivedOn: string },
  meta: RequestMeta,
): Promise<PaymentDto> {
  return withTransaction(deps.pool, async (tx) => {
    const p = await lockPayment(tx, ctx, id);
    if (toPaise(p.tds_amount) === 0) throw conflict('No TDS was deducted on this payment');
    await query(
      tx,
      sql`UPDATE payments SET tds_certificate_number = ${input.certificateNumber}, tds_certificate_received_at = ${input.receivedOn} WHERE id = ${id}`,
    );
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'payment.tds_certificate',
      entityType: 'payment',
      entityId: id,
      after: input,
      meta,
    });
    return getPayment(tx, ctx, id);
  });
}
