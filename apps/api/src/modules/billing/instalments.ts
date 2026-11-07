import type { InstalmentDto, InstalmentStatus } from '@legalops/types';
import { fromPaise, toPaise } from '@legalops/validation';
import { query, type Db } from '../../db/pool.js';
import { sql } from '../../db/sql.js';
import { validationError } from '../../http/errors.js';
import { toDto, type LinkRow } from '../online-payments/link-dto.js';

type InstalmentInput = { amount: string; dueDate: string };

/**
 * Replaces an invoice's instalment schedule. `undefined` or `[]` deletes it (callers on update only call this when the
 * `instalments` key is present). Amounts must add up to the invoice total exactly; the invoice due date becomes the
 * last instalment's date.
 */
export async function writeInstalments(
  db: Db,
  orgId: string,
  invoiceId: string,
  instalments: InstalmentInput[] | undefined,
  totalPaise: number,
): Promise<void> {
  assertInstalmentsSum(instalments, totalPaise);
  await query(db, sql`DELETE FROM invoice_instalments WHERE invoice_id = ${invoiceId}`);
  if (!instalments || instalments.length === 0) return;
  for (const [i, it] of instalments.entries()) {
    await query(
      db,
      sql`INSERT INTO invoice_instalments (organization_id, invoice_id, seq, amount, due_date)
          VALUES (${orgId}, ${invoiceId}, ${i + 1}, ${fromPaise(toPaise(it.amount))}, ${it.dueDate})`,
    );
  }
  await query(
    db,
    sql`UPDATE invoices SET due_date = ${instalments[instalments.length - 1]!.dueDate} WHERE id = ${invoiceId}`,
  );
}

export function assertInstalmentsSum(instalments: InstalmentInput[] | undefined, totalPaise: number): void {
  if (!instalments || instalments.length === 0) return;
  const sum = instalments.reduce((acc, it) => acc + toPaise(it.amount), 0);
  if (sum !== totalPaise)
    throw validationError('Instalments must add up to the invoice total', [
      {
        path: 'instalments',
        message: `Instalments add up to ${fromPaise(sum)} but the invoice total is ${fromPaise(totalPaise)}`,
      },
    ]);
}

/** Re-checks a stored schedule against the (re)computed total; returns the last due date, or null when there is none. */
export async function checkStoredInstalments(
  db: Db,
  invoiceId: string,
  totalPaise: number,
): Promise<string | null> {
  const rows = await query<{ amount: string; due_date: string }>(
    db,
    sql`SELECT amount::text, due_date::text FROM invoice_instalments WHERE invoice_id = ${invoiceId} ORDER BY seq`,
  );
  if (rows.length === 0) return null;
  assertInstalmentsSum(
    rows.map((r) => ({ amount: r.amount, dueDate: r.due_date })),
    totalPaise,
  );
  return rows[rows.length - 1]!.due_date;
}

/** Pure derivation: allocations (including TDS), then credit notes, are applied to instalments in order. */
export function deriveStatus(
  amountPaise: number,
  coveredPaise: number,
  dueDate: string,
  today: string,
): { paid: number; status: InstalmentStatus } {
  const paid = Math.min(amountPaise, coveredPaise);
  const remaining = amountPaise - paid;
  const status: InstalmentStatus =
    remaining === 0 ? 'paid' : dueDate < today ? 'overdue' : paid > 0 ? 'part_paid' : 'due';
  return { paid, status };
}

type InstalmentLinkRow = LinkRow & { instalment_id: string };

export async function instalmentStatus(db: Db, invoiceId: string, today: string): Promise<InstalmentDto[]> {
  const rows = await query<{
    id: string;
    seq: number;
    amount: string;
    due_date: string;
    emailed_at: Date | null;
  }>(
    db,
    sql`SELECT id, seq, amount::text, due_date::text, emailed_at
        FROM invoice_instalments WHERE invoice_id = ${invoiceId} ORDER BY seq`,
  );
  if (rows.length === 0) return [];
  // Payments first, then credit notes, consumed from the earliest instalment: the schedule's remaining never exceeds
  // what the invoice actually still owes (v_invoice_balances.amount_due). A write-off closes the invoice instead.
  const cov = await query<{ covered: string }>(
    db,
    sql`SELECT (amount_paid + amount_credited)::text AS covered FROM v_invoice_balances WHERE invoice_id = ${invoiceId}`,
  );
  let covered = Math.max(0, toPaise(cov[0]?.covered ?? '0'));
  const links = await query<InstalmentLinkRow>(
    db,
    sql`SELECT l.id, l.invoice_id, l.provider_link_id, l.instalment_id, l.url, l.amount::text, l.currency, l.status, l.expires_at,
               l.paid_at, p.receipt_number, l.created_at, l.environment
        FROM payment_links l LEFT JOIN payments p ON p.id = l.payment_id
        WHERE l.invoice_id = ${invoiceId} AND l.instalment_id IS NOT NULL AND l.status = 'active'`,
  );
  const linkBy = new Map(links.map((l) => [l.instalment_id, l]));
  return rows.map((r) => {
    const amount = toPaise(r.amount);
    const { paid, status } = deriveStatus(amount, covered, r.due_date, today);
    covered -= paid;
    const l = linkBy.get(r.id);
    return {
      id: r.id,
      seq: r.seq,
      amount: fromPaise(amount),
      dueDate: r.due_date,
      paid: fromPaise(paid),
      remaining: fromPaise(amount - paid),
      status,
      emailedAt: r.emailed_at?.toISOString() ?? null,
      activeLink: l ? toDto(l) : null,
    };
  });
}
