import type { ExpenseDto } from '@legalops/types';
import {
  toPaise,
  type expenseSchema,
  type listExpensesSchema,
  type updateExpenseSchema,
} from '@legalops/validation';
import type { z } from 'zod';
import { query, queryOne, withTransaction, type Db } from '../../db/pool.js';
import { sql, type SqlFragment } from '../../db/sql.js';
import type { Deps } from '../../deps.js';
import type { RequestMeta, TenantContext } from '../../http/context.js';
import { conflict, notFound, validationError } from '../../http/errors.js';
import { iso } from '../../http/query-helpers.js';
import { assertMatterVisible, matterVisible } from '../access/matter-scope.js';
import { recordAudit } from '../audit/audit.service.js';
import { addTimelineEvent } from '../timeline/timeline.service.js';
import { rupees } from './invoices.service.js';
import { postLedger } from './ledger.js';

type Row = {
  id: string;
  matter_id: string | null;
  matter_title: string | null;
  case_id: string | null;
  category: string | null;
  amount: string;
  expense_date: string;
  description: string | null;
  vendor_name: string | null;
  billable_to_client: boolean;
  reimbursable: boolean;
  status: ExpenseDto['status'];
  invoice_id: string | null;
  created_by: string | null;
  first_name: string | null;
  last_name: string | null;
  created_at: Date;
};

async function queryExpenses(db: Db, ctx: TenantContext, where: SqlFragment[]): Promise<ExpenseDto[]> {
  const rows = await query<Row>(
    db,
    sql`SELECT e.id, e.matter_id, m.title AS matter_title, e.case_id, e.category, e.amount::text, e.expense_date::text,
               e.description, e.vendor_name, e.billable_to_client, e.reimbursable, e.status,
               (SELECT ii.invoice_id FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
                 WHERE ii.expense_id = e.id AND i.status <> 'void' LIMIT 1) AS invoice_id,
               e.created_by, u.first_name, u.last_name, e.created_at
        FROM expenses e LEFT JOIN matters m ON m.id = e.matter_id LEFT JOIN users u ON u.id = e.created_by
        WHERE ${sql.join([sql`e.organization_id = ${ctx.organizationId}`, matterVisible(ctx, sql.raw('e.matter_id')), ...where], ' AND ')}
        ORDER BY e.expense_date DESC, e.created_at DESC
        LIMIT 500`,
  );
  return rows.map((r) => ({
    id: r.id,
    matter: r.matter_id ? { id: r.matter_id, title: r.matter_title ?? '' } : null,
    caseId: r.case_id,
    category: r.category,
    amount: r.amount,
    expenseDate: r.expense_date,
    description: r.description,
    vendorName: r.vendor_name,
    billableToClient: r.billable_to_client,
    reimbursable: r.reimbursable,
    status: r.status,
    invoiceId: r.invoice_id,
    createdBy: r.created_by
      ? { userId: r.created_by, firstName: r.first_name ?? '', lastName: r.last_name }
      : null,
    createdAt: iso(r.created_at)!,
  }));
}

export async function listExpenses(deps: Deps, ctx: TenantContext, f: z.output<typeof listExpensesSchema>) {
  const where: SqlFragment[] = [];
  if (f.matterId) where.push(sql`e.matter_id = ${f.matterId}`);
  if (f.status === 'unbilled') where.push(sql`e.status = 'recorded' AND e.billable_to_client`);
  else if (f.status !== 'all') where.push(sql`e.status = ${f.status}`);
  return queryExpenses(deps.pool, ctx, where);
}

async function getExpense(db: Db, ctx: TenantContext, id: string) {
  const [e] = await queryExpenses(db, ctx, [sql`e.id = ${id}`]);
  if (!e) throw notFound('Expense');
  return e;
}

export async function createExpense(
  deps: Deps,
  ctx: TenantContext,
  input: z.output<typeof expenseSchema>,
  meta: RequestMeta,
) {
  return withTransaction(deps.pool, async (tx) => {
    await assertMatterVisible(tx, ctx, input.matterId);
    if (input.caseId) {
      const ok = await queryOne(
        tx,
        sql`SELECT 1 FROM cases WHERE id = ${input.caseId} AND matter_id = ${input.matterId}`,
      );
      if (!ok)
        throw validationError('That case belongs to another matter', [
          { path: 'caseId', message: 'Mismatched case' },
        ]);
    }
    const row = await queryOne<{ id: string; client_id: string }>(
      tx,
      sql`INSERT INTO expenses (organization_id, matter_id, case_id, category, amount, expense_date, description, vendor_name,
                                billable_to_client, reimbursable, created_by)
          VALUES (${ctx.organizationId}, ${input.matterId}, ${input.caseId ?? null}, ${input.category ?? null}, ${input.amount},
                  ${input.expenseDate}, ${input.description ?? null}, ${input.vendorName ?? null}, ${input.billableToClient},
                  ${input.reimbursable}, ${ctx.userId})
          RETURNING id, (SELECT client_id FROM matters WHERE id = ${input.matterId}) AS client_id`,
    );
    const id = row!.id;
    await postLedger(tx, ctx.organizationId, ctx.userId, [
      {
        entryType: 'expense_recorded',
        debit: 'expense',
        credit: 'expense_payable',
        amountPaise: toPaise(input.amount),
        matterId: input.matterId,
        clientId: row!.client_id,
        metadata: { expenseId: id },
      },
    ]);
    await addTimelineEvent(tx, {
      organizationId: ctx.organizationId,
      matterId: input.matterId,
      caseId: input.caseId ?? null,
      eventType: 'expense.recorded',
      title: `Expense: ${input.category ?? 'Expense'} ${rupees(toPaise(input.amount))}`,
      description: [input.description, input.billableToClient ? 'billable to client' : 'not billable']
        .filter(Boolean)
        .join(' · '),
      actorUserId: ctx.userId,
      sourceType: 'expense',
      sourceId: id,
    });
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'expense.recorded',
      entityType: 'expense',
      entityId: id,
      after: input,
      meta,
    });
    return getExpense(tx, ctx, id);
  });
}

const COLUMNS = {
  category: 'category',
  amount: 'amount',
  expenseDate: 'expense_date',
  description: 'description',
  vendorName: 'vendor_name',
  billableToClient: 'billable_to_client',
  reimbursable: 'reimbursable',
} as const;

export async function updateExpense(
  deps: Deps,
  ctx: TenantContext,
  id: string,
  input: z.output<typeof updateExpenseSchema>,
  meta: RequestMeta,
) {
  return withTransaction(deps.pool, async (tx) => {
    const before = await getExpense(tx, ctx, id);
    if (before.status !== 'recorded')
      throw conflict(
        before.status === 'billed'
          ? 'This expense is on an invoice; void the invoice first'
          : 'This expense is void',
      );
    if (input.amount !== undefined && input.amount !== before.amount) {
      // Amount changes are a void + new expense, so the ledger stays a true history.
      throw conflict('To change the amount, void this expense and record a new one');
    }
    const keys = (Object.keys(COLUMNS) as (keyof typeof COLUMNS)[]).filter(
      (k) => input[k] !== undefined && k !== 'amount',
    );
    if (keys.length)
      await query(
        tx,
        sql`UPDATE expenses SET ${sql.join(keys.map((k) => sql`${sql.raw(COLUMNS[k])} = ${input[k]}`))} WHERE id = ${id}`,
      );
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'expense.updated',
      entityType: 'expense',
      entityId: id,
      before,
      after: input,
      meta,
    });
    return getExpense(tx, ctx, id);
  });
}

export async function voidExpense(
  deps: Deps,
  ctx: TenantContext,
  id: string,
  reason: string,
  meta: RequestMeta,
) {
  return withTransaction(deps.pool, async (tx) => {
    const e = await getExpense(tx, ctx, id);
    await query(tx, sql`SELECT 1 FROM expenses WHERE id = ${id} FOR UPDATE`);
    if (e.status !== 'recorded')
      throw conflict(
        e.status === 'billed' ? 'This expense is on an invoice; void the invoice first' : 'Already void',
      );
    await query(
      tx,
      sql`UPDATE expenses SET status = 'void', voided_at = now(), voided_by = ${ctx.userId}, void_reason = ${reason} WHERE id = ${id}`,
    );
    await postLedger(tx, ctx.organizationId, ctx.userId, [
      {
        entryType: 'expense_voided',
        debit: 'expense_payable',
        credit: 'expense',
        amountPaise: toPaise(e.amount),
        matterId: e.matter?.id ?? null,
        metadata: { expenseId: id },
      },
    ]);
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'expense.voided',
      entityType: 'expense',
      entityId: id,
      after: { reason },
      meta,
    });
    return getExpense(tx, ctx, id);
  });
}
