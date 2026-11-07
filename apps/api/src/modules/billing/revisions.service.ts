import type { InvoiceDetailDto } from '@legalops/types';
import { fromPaise, toPaise, type reviseInvoiceSchema } from '@legalops/validation';
import type { z } from 'zod';
import { query, queryOne, withTransaction, type Db } from '../../db/pool.js';
import { sql } from '../../db/sql.js';
import type { Deps } from '../../deps.js';
import type { RequestMeta, TenantContext } from '../../http/context.js';
import { displayDate, orgToday } from '../../http/dates.js';
import { AppError, conflict, notFound, validationError } from '../../http/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { createNotification, INVOICE_PDF_TEMPLATES } from '../notifications/notifications.service.js';
import { cancelStaleLink } from '../online-payments/payment-links.service.js';
import { loadZohoPay } from '../online-payments/zohopay-config.service.js';
import { emitEvent } from '../outbox/outbox.service.js';
import { addTimelineEvent } from '../timeline/timeline.service.js';
import { assertInstalmentsSum, instalmentStatus } from './instalments.js';
import {
  getInvoice,
  loadMatterClient,
  loadOrgTax,
  lockInvoice,
  prepareDraft,
  rupees,
  totalsColumns,
  writeItems,
} from './invoices.service.js';
import { postLedger, type LedgerEntry } from './ledger.js';
import { invoiceVisible } from './visibility.js';

type ReviseInput = z.output<typeof reviseInvoiceSchema>;

const GST_REFUSAL = 'GST invoices can’t be edited; issue a credit note';
const CHANGED = 'Invoice changed, try again';
const NOT_SENT = 'This invoice hasn’t been sent yet. Save without notifying, then use Send.';

type Snapshot = {
  revision: number;
  paidPaise: number;
  creditedPaise: number;
  /** Payments plus credit notes (what instalmentStatus applies in seq order). */
  coveredPaise: number;
};

type CurrentInstalment = { id: string; seq: number; amount: number; dueDate: string; paid: number; status: string };
type PlannedInstalment = { seq: number; amount: number; dueDate: string; existingId: string | null };
type ActiveLink = { id: string; provider_link_id: string; instalment_id: string | null; amount: string };

async function snapshot(db: Db, invoiceId: string): Promise<Snapshot> {
  const r = (await queryOne<{ revision: number; paid: string; credited: string }>(
    db,
    sql`SELECT i.revision, b.amount_paid::text AS paid, b.amount_credited::text AS credited
        FROM invoices i JOIN v_invoice_balances b ON b.invoice_id = i.id WHERE i.id = ${invoiceId}`,
  ))!;
  const paidPaise = toPaise(r.paid);
  const creditedPaise = toPaise(r.credited);
  return { revision: r.revision, paidPaise, creditedPaise, coveredPaise: paidPaise + creditedPaise };
}

const sameSnapshot = (a: Snapshot, b: Snapshot) =>
  a.revision === b.revision && a.paidPaise === b.paidPaise && a.creditedPaise === b.creditedPaise && a.coveredPaise === b.coveredPaise;

/** Remaining per planned instalment once the covered amount is re-applied in seq order (same rule as instalmentStatus). */
function remainingBySeq(planned: PlannedInstalment[], coveredPaise: number): Map<number, number> {
  let covered = coveredPaise;
  const out = new Map<number, number>();
  for (const p of planned) {
    const paid = Math.min(p.amount, covered);
    covered -= paid;
    out.set(p.seq, p.amount - paid);
  }
  return out;
}

/**
 * Links that would carry a wrong amount after the revision. An instalment link is stale when its instalment goes away
 * or its amount differs from the instalment's new remaining amount. A whole-invoice link is stale when the invoice
 * gains a schedule, when it is more than the new amount due, or when the amount due changes and it doesn't match it
 * (a deliberately partial link survives a revision that leaves the amount due unchanged).
 */
function staleLinks(
  links: ActiveLink[],
  current: CurrentInstalment[],
  planned: PlannedInstalment[],
  coveredPaise: number,
  oldDuePaise: number,
  newDuePaise: number,
): ActiveLink[] {
  const seqById = new Map(current.map((c) => [c.id, c.seq]));
  const remaining = remainingBySeq(planned, coveredPaise);
  return links.filter((l) => {
    const amount = toPaise(l.amount);
    if (l.instalment_id) {
      const seq = seqById.get(l.instalment_id);
      const left = seq === undefined ? undefined : remaining.get(seq);
      return left === undefined || left !== amount;
    }
    if (planned.length > 0) return true;
    if (amount > newDuePaise) return true;
    return newDuePaise !== oldDuePaise && amount !== newDuePaise;
  });
}

/**
 * Revises an issued simple-mode invoice in place (spec §6). Validation and amounts are worked out first; links whose
 * amount would go stale are then cancelled at Zoho (outside any transaction); the revision itself is one transaction
 * that locks the invoice and aborts if a payment or another revision landed in between.
 */
export async function reviseInvoice(
  deps: Deps,
  ctx: TenantContext,
  id: string,
  input: ReviseInput,
  meta: RequestMeta,
  fetchImpl: typeof fetch = fetch,
): Promise<InvoiceDetailDto> {
  const db = deps.pool;
  const inv = await queryOne<{
    status: string;
    tax_mode: 'simple' | 'gst';
    sent_at: Date | null;
    matter_id: string;
    client_id: string;
    invoice_number: string;
    issue_date: string;
    due_date: string;
    total_amount: string;
    tax_amount: string;
    subtotal: string;
    discount_amount: string;
    notes: string | null;
  }>(
    db,
    sql`SELECT i.status, i.tax_mode, i.sent_at, i.matter_id, i.client_id, i.invoice_number, i.issue_date::text, i.due_date::text,
               i.total_amount::text, i.tax_amount::text, i.subtotal::text, i.discount_amount::text, i.notes
        FROM invoices i WHERE i.id = ${id} AND i.organization_id = ${ctx.organizationId} AND ${invoiceVisible(ctx)}`,
  );
  if (!inv) throw notFound('Invoice');
  const org = await loadOrgTax(db, ctx.organizationId);
  if (org.tax_mode === 'gst' || inv.tax_mode === 'gst') throw conflict(GST_REFUSAL);
  if (inv.status !== 'issued') throw conflict('Only an issued invoice can be revised');
  if (input.notifyClient && !inv.sent_at)
    throw validationError(NOT_SENT, [{ path: 'notifyClient', message: 'The invoice hasn’t been sent yet' }]);
  if (input.issueDate && input.issueDate !== inv.issue_date)
    throw validationError('The issue date of an issued invoice can’t change', [{ path: 'issueDate', message: 'Fixed at issue' }]);

  const mc = await loadMatterClient(db, ctx, inv.matter_id);
  const { items, totals } = await prepareDraft(db, ctx, inv.matter_id, 'simple', input, org, mc, id);
  const before = await snapshot(db, id);

  const settled = before.paidPaise + before.creditedPaise;
  if (totals.total < settled)
    throw validationError(`The new total can’t be less than what has been paid or credited (${rupees(settled)})`, [
      { path: 'items', message: 'Below the amount already settled' },
    ]);

  // The schedule, matched by seq against the one derived before the revision.
  const today = await orgToday(db, ctx.organizationId);
  const current: CurrentInstalment[] = (await instalmentStatus(db, id, today)).map((i) => ({
    id: i.id,
    seq: i.seq,
    amount: toPaise(i.amount),
    dueDate: i.dueDate,
    paid: toPaise(i.paid),
    status: i.status,
  }));
  const bySeq = new Map(current.map((c) => [c.seq, c]));
  const requested =
    input.instalments === undefined
      ? current.map((c) => ({ amount: fromPaise(c.amount), dueDate: c.dueDate }))
      : input.instalments;
  assertInstalmentsSum(requested, totals.total);
  const planned: PlannedInstalment[] = requested.map((r, i) => ({
    seq: i + 1,
    amount: toPaise(r.amount),
    dueDate: r.dueDate,
    existingId: bySeq.get(i + 1)?.id ?? null,
  }));
  for (const c of current) {
    const p = planned.find((x) => x.seq === c.seq);
    if (!p) {
      if (c.paid > 0) throw conflict(`Instalment ${c.seq} has payments against it and can’t be removed`);
      continue;
    }
    if (c.status === 'paid' && (p.amount !== c.amount || p.dueDate !== c.dueDate))
      throw conflict(`Instalment ${c.seq} is paid; its amount and due date can’t change`);
    if (p.amount < c.paid)
      throw conflict(`Instalment ${c.seq} can’t be less than the ${rupees(c.paid)} already paid or credited on it`);
  }

  const notes = input.notes === undefined ? inv.notes : input.notes;
  const dueDate = planned.length > 0 ? planned[planned.length - 1]!.dueDate : (input.dueDate ?? inv.due_date);
  if (dueDate < inv.issue_date)
    throw validationError('Due date cannot be before the issue date', [{ path: 'dueDate', message: 'Before issue date' }]);

  // Withdraw links whose amount will be wrong, at Zoho first. A refusal stops the revision before anything else changes.
  const oldDue = toPaise(inv.total_amount) - settled;
  const newDue = totals.total - settled;
  const activeLinks = await query<ActiveLink>(
    db,
    sql`SELECT id, provider_link_id, instalment_id, amount::text FROM payment_links WHERE invoice_id = ${id} AND status = 'active'`,
  );
  const stale = staleLinks(activeLinks, current, planned, before.coveredPaise, oldDue, newDue);
  if (stale.length > 0) {
    const cfg = await loadZohoPay(deps, db, ctx.organizationId);
    if (!cfg) throw new AppError(409, 'NOT_CONFIGURED', 'An open payment link can’t be cancelled because online payments aren’t set up. Nothing was changed.');
    for (const l of stale) {
      try {
        await cancelStaleLink(deps, cfg.credentials, ctx.organizationId, l, ctx.userId, 'invoice revised', fetchImpl, meta);
      } catch (err) {
        deps.log.warn({ err, invoiceId: id, linkId: l.id }, 'revision: payment link could not be cancelled');
        throw new AppError(
          502,
          'INTERNAL_ERROR',
          'Zoho couldn’t cancel the open payment link, so the invoice was not revised. Try again in a moment.',
        );
      }
    }
  }

  return withTransaction(db, async (tx) => {
    const locked = await lockInvoice(tx, ctx, id);
    if (locked.status !== 'issued' || locked.tax_mode !== 'simple') throw conflict(CHANGED);
    if (!sameSnapshot(before, await snapshot(tx, id))) throw conflict(CHANGED);
    // A link opened after the pre-check (e.g. by a scheduled email) for an amount we're about to change.
    const raced = staleLinks(
      await query<ActiveLink>(
        tx,
        sql`SELECT id, provider_link_id, instalment_id, amount::text FROM payment_links WHERE invoice_id = ${id} AND status = 'active'`,
      ),
      current,
      planned,
      before.coveredPaise,
      oldDue,
      newDue,
    );
    if (raced.length > 0) throw conflict(CHANGED);

    // Milestones and expenses: newly linked ones become invoiced/billed, unlinked ones go back to planned/recorded.
    const oldLinks = await query<{ fee_milestone_id: string | null; expense_id: string | null }>(
      tx,
      sql`SELECT fee_milestone_id, expense_id FROM invoice_items WHERE invoice_id = ${id}`,
    );
    const oldMilestones = new Set(oldLinks.map((l) => l.fee_milestone_id).filter((x): x is string => !!x));
    const oldExpenses = new Set(oldLinks.map((l) => l.expense_id).filter((x): x is string => !!x));
    const newMilestones = new Set(items.map((l) => l.feeMilestoneId).filter((x): x is string => !!x));
    const newExpenses = new Set(items.map((l) => l.expenseId).filter((x): x is string => !!x));
    for (const m of newMilestones) {
      if (oldMilestones.has(m)) continue;
      const ok = await queryOne(tx, sql`SELECT 1 FROM fee_milestones WHERE id = ${m} AND status = 'planned' FOR UPDATE`);
      if (!ok) throw conflict('A milestone on this invoice is no longer billable');
    }
    for (const e of newExpenses) {
      if (oldExpenses.has(e)) continue;
      const ok = await queryOne(tx, sql`SELECT 1 FROM expenses WHERE id = ${e} AND status = 'recorded' FOR UPDATE`);
      if (!ok) throw conflict('An expense on this invoice is no longer billable');
    }

    const beforeItems = await query(
      tx,
      sql`SELECT description, quantity::text, unit_price::text, amount::text FROM invoice_items WHERE invoice_id = ${id} ORDER BY position`,
    );
    await writeItems(tx, ctx, id, items, totals.lineAmounts);
    for (const m of oldMilestones)
      if (!newMilestones.has(m)) await query(tx, sql`UPDATE fee_milestones SET status = 'planned', invoice_id = NULL WHERE id = ${m}`);
    for (const m of newMilestones)
      if (!oldMilestones.has(m)) await query(tx, sql`UPDATE fee_milestones SET status = 'invoiced', invoice_id = ${id} WHERE id = ${m}`);
    for (const e of oldExpenses)
      if (!newExpenses.has(e)) await query(tx, sql`UPDATE expenses SET status = 'recorded' WHERE id = ${e}`);
    for (const e of newExpenses)
      if (!oldExpenses.has(e)) await query(tx, sql`UPDATE expenses SET status = 'billed' WHERE id = ${e}`);

    const rev = (await queryOne<{ revision: number }>(
      tx,
      sql`UPDATE invoices SET ${totalsColumns(totals)}, due_date = ${dueDate}, notes = ${notes},
            revision = revision + 1, revised_at = now()
          WHERE id = ${id} RETURNING revision`,
    ))!.revision;

    // Instalments are updated in place by seq so their ids (links, emailed_at, scheduled actions) survive.
    for (const p of planned) {
      if (p.existingId) {
        await query(
          tx,
          sql`UPDATE invoice_instalments SET amount = ${fromPaise(p.amount)}, due_date = ${p.dueDate},
                emailed_at = CASE WHEN due_date <> ${p.dueDate}::date THEN NULL ELSE emailed_at END
              WHERE id = ${p.existingId}`,
        );
      } else {
        await query(
          tx,
          sql`INSERT INTO invoice_instalments (organization_id, invoice_id, seq, amount, due_date)
              VALUES (${ctx.organizationId}, ${id}, ${p.seq}, ${fromPaise(p.amount)}, ${p.dueDate})`,
        );
      }
    }
    const removed = current.filter((c) => !planned.some((p) => p.seq === c.seq)).map((c) => c.id);
    if (removed.length > 0) {
      // Closed links keep their invoice; they just stop pointing at an instalment that no longer exists.
      await query(tx, sql`UPDATE payment_links SET instalment_id = NULL WHERE instalment_id = ANY(${removed}::uuid[]) AND status <> 'active'`);
      await query(tx, sql`DELETE FROM invoice_instalments WHERE id = ANY(${removed}::uuid[])`);
    }

    // Append-only ledger delta, in the same accounts the issue posting used (fees net of tax; simple tax to gst_output).
    const oldTax = toPaise(inv.tax_amount);
    const feeDelta = totals.total - totals.tax - (toPaise(inv.total_amount) - oldTax);
    const taxDelta = totals.tax - oldTax;
    const base = { matterId: inv.matter_id, clientId: inv.client_id, invoiceId: id, metadata: { revision: rev } };
    const delta = (amount: number, account: 'fee_revenue' | 'gst_output'): LedgerEntry =>
      amount >= 0
        ? { ...base, entryType: 'invoice_revised', debit: 'accounts_receivable', credit: account, amountPaise: amount }
        : { ...base, entryType: 'invoice_revised', debit: account, credit: 'accounts_receivable', amountPaise: -amount };
    await postLedger(tx, ctx.organizationId, ctx.userId, [delta(feeDelta, 'fee_revenue'), delta(taxDelta, 'gst_output')]);

    // Emails not yet sent for this invoice carry the old figures in their rendered subject/body: withdraw them. The
    // revision's own invoice_updated (below) is created afterwards, and approving a withdrawn one is refused.
    await query(
      tx,
      sql`UPDATE notifications SET status = 'cancelled', skip_reason = 'invoice_revised'
          WHERE organization_id = ${ctx.organizationId} AND invoice_id = ${id}
            AND status IN ('pending', 'awaiting_approval', 'queued')
            AND notification_type = ANY(${[...INVOICE_PDF_TEMPLATES]}::text[])`,
    );

    // A DSC-signed copy shows the old figures.
    await query(tx, sql`UPDATE invoice_signed_documents SET superseded_at = now() WHERE invoice_id = ${id} AND superseded_at IS NULL`);

    await addTimelineEvent(tx, {
      organizationId: ctx.organizationId,
      matterId: inv.matter_id,
      clientId: inv.client_id,
      eventType: 'invoice.revised',
      title: `Invoice ${inv.invoice_number} revised (revision ${rev}): ${rupees(toPaise(inv.total_amount))} → ${rupees(totals.total)}`,
      description: `Due ${displayDate(dueDate)}`,
      actorUserId: ctx.userId,
      sourceType: 'invoice',
      sourceId: id,
    });
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'invoice.revised',
      entityType: 'invoice',
      entityId: id,
      before: {
        revision: before.revision,
        subtotal: inv.subtotal,
        discount: inv.discount_amount,
        tax: inv.tax_amount,
        total: inv.total_amount,
        dueDate: inv.due_date,
        notes: inv.notes,
        items: beforeItems,
        instalments: current.map((c) => ({ seq: c.seq, amount: fromPaise(c.amount), dueDate: c.dueDate })),
      },
      after: {
        revision: rev,
        subtotal: fromPaise(totals.subtotal),
        discount: fromPaise(totals.discount),
        tax: fromPaise(totals.tax),
        total: fromPaise(totals.total),
        dueDate,
        notes: notes,
        items: items.map((it, i) => ({ description: it.description, quantity: it.quantity, unitPrice: it.unitPrice, amount: fromPaise(totals.lineAmounts[i]!) })),
        instalments: planned.map((p) => ({ seq: p.seq, amount: fromPaise(p.amount), dueDate: p.dueDate })),
        notifyClient: input.notifyClient,
        linksCancelled: stale.length,
      },
      meta,
    });
    await emitEvent(tx, {
      organizationId: ctx.organizationId,
      eventType: 'INVOICE_REVISED',
      aggregateType: 'invoice',
      aggregateId: id,
      payload: {
        invoiceId: id,
        notifyClient: input.notifyClient,
        matterId: inv.matter_id,
        clientId: inv.client_id,
        revision: rev,
        total: fromPaise(totals.total),
        dueDate,
      },
      actorUserId: ctx.userId,
      dedupeKey: `INVOICE_REVISED:${id}:${rev}`,
    });
    if (input.notifyClient) {
      await createNotification(tx, deps.env.APP_URL, {
        organizationId: ctx.organizationId,
        templateKey: 'invoice_updated',
        recipient: { type: 'client', clientId: inv.client_id },
        refs: { invoiceId: id, matterId: inv.matter_id, clientId: inv.client_id },
        now: new Date(),
        createdBy: ctx.userId,
        idempotencyKey: `invoice-revised:${id}:${rev}`,
      });
    }
    return getInvoice(tx, ctx, id);
  });
}
