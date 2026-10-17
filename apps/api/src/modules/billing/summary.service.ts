import {
  AGING_BUCKETS,
  seesAllMatters,
  type BillingSummaryDto,
  type ClientBalanceDto,
  type MatterBillingDto,
} from '@legalops/types';
import { agingBucket, fromPaise, toPaise } from '@legalops/validation';
import { queryOne, type Db } from '../../db/pool.js';
import { sql } from '../../db/sql.js';
import type { Deps } from '../../deps.js';
import type { TenantContext } from '../../http/context.js';
import { orgToday } from '../../http/dates.js';
import { notFound } from '../../http/errors.js';
import { assertMatterVisible } from '../access/matter-scope.js';
import { OPEN_ISSUED, queryInvoices } from './invoices.service.js';
import { queryPayments } from './payments.service.js';
import { invoiceVisible, paymentVisible } from './visibility.js';

const TODAY = sql`(now() AT TIME ZONE o.timezone)::date`;

/** Outstanding and overdue amounts over the invoices the caller can see. Used by billing and the main dashboard. */
export async function receivableTotals(
  db: Db,
  ctx: TenantContext,
): Promise<{ outstanding: string; overdue: string }> {
  const r = await queryOne<{ outstanding: string; overdue: string }>(
    db,
    sql`SELECT COALESCE(sum(b.amount_due) FILTER (WHERE ${OPEN_ISSUED}), 0)::numeric(14,2)::text AS outstanding,
               COALESCE(sum(b.amount_due) FILTER (WHERE ${OPEN_ISSUED} AND i.due_date < ${TODAY}), 0)::numeric(14,2)::text AS overdue
        FROM invoices i JOIN v_invoice_balances b ON b.invoice_id = i.id JOIN organizations o ON o.id = i.organization_id
        WHERE i.organization_id = ${ctx.organizationId} AND ${invoiceVisible(ctx)}`,
  );
  return r!;
}

export async function billingSummary(deps: Deps, ctx: TenantContext): Promise<BillingSummaryDto> {
  const db = deps.pool;
  const today = await orgToday(db, ctx.organizationId);
  const monthStart = `${today.slice(0, 7)}-01`;
  const money = await queryOne<{ invoiced: string; due_week: string }>(
    db,
    sql`SELECT COALESCE(sum(i.total_amount) FILTER (WHERE i.status IN ('issued', 'written_off') AND i.issue_date >= ${monthStart}), 0)::numeric(14,2)::text AS invoiced,
               COALESCE(sum(b.amount_due) FILTER (WHERE ${OPEN_ISSUED} AND i.due_date BETWEEN ${today}::date AND ${today}::date + 7), 0)::numeric(14,2)::text AS due_week
        FROM invoices i JOIN v_invoice_balances b ON b.invoice_id = i.id
        WHERE i.organization_id = ${ctx.organizationId} AND ${invoiceVisible(ctx)}`,
  );
  const received = await queryOne<{ s: string }>(
    db,
    sql`SELECT COALESCE(sum(p.amount + p.tds_amount), 0)::numeric(14,2)::text AS s FROM payments p
        WHERE p.organization_id = ${ctx.organizationId} AND p.status = 'posted' AND p.payment_date >= ${monthStart}
          AND ${paymentVisible(ctx)}`,
  );
  const advances = seesAllMatters(ctx.role)
    ? (await queryOne<{ s: string }>(
        db,
        sql`SELECT COALESCE(sum(unallocated_amount), 0)::numeric(14,2)::text AS s FROM v_payment_unallocated WHERE organization_id = ${ctx.organizationId}`,
      ))!.s
    : '0.00';
  const { outstanding, overdue } = await receivableTotals(db, ctx);

  const overdueList = await queryInvoices(
    db,
    ctx,
    [OPEN_ISSUED, sql`i.due_date < ${TODAY}`],
    sql`i.due_date ASC`,
  );
  const aging = Object.fromEntries(AGING_BUCKETS.map((b) => [b, { count: 0, paise: 0 }])) as Record<
    (typeof AGING_BUCKETS)[number],
    { count: number; paise: number }
  >;
  for (const inv of overdueList.items) {
    const bucket = aging[agingBucket(inv.daysOverdue)];
    bucket.count += 1;
    bucket.paise += toPaise(inv.amountDue);
  }
  const dueSoon = await queryInvoices(
    db,
    ctx,
    [OPEN_ISSUED, sql`i.due_date >= ${TODAY}`, sql`i.due_date <= ${TODAY} + 14`],
    sql`i.due_date ASC`,
    { page: 1, pageSize: 10 },
  );
  const recent = await queryPayments(db, ctx, [], { page: 1, pageSize: 10 });

  return {
    today,
    scope: seesAllMatters(ctx.role) ? 'firm' : 'mine',
    invoicedThisMonth: money!.invoiced,
    receivedThisMonth: received!.s,
    outstanding,
    overdue,
    dueThisWeek: money!.due_week,
    unallocatedAdvances: advances,
    aging: Object.fromEntries(
      AGING_BUCKETS.map((b) => [b, { count: aging[b].count, amount: fromPaise(aging[b].paise) }]),
    ) as BillingSummaryDto['aging'],
    overdueInvoices: [...overdueList.items].sort((a, b) => b.daysOverdue - a.daysOverdue).slice(0, 10),
    dueSoon: dueSoon.items,
    recentPayments: recent.items,
  };
}

export async function agingList(deps: Deps, ctx: TenantContext, bucket?: (typeof AGING_BUCKETS)[number]) {
  const { items } = await queryInvoices(
    deps.pool,
    ctx,
    [OPEN_ISSUED, sql`i.due_date < ${TODAY}`],
    sql`i.due_date ASC`,
  );
  return items.filter((i) => !bucket || agingBucket(i.daysOverdue) === bucket);
}

export async function matterBilling(
  deps: Deps,
  ctx: TenantContext,
  matterId: string,
): Promise<MatterBillingDto> {
  await assertMatterVisible(deps.pool, ctx, matterId);
  const r = await queryOne<Record<keyof MatterBillingDto, string>>(
    deps.pool,
    sql`SELECT COALESCE(sum(i.total_amount) FILTER (WHERE i.status IN ('issued', 'written_off')), 0)::numeric(14,2)::text AS invoiced,
               COALESCE(sum(b.amount_paid) FILTER (WHERE i.status <> 'void'), 0)::numeric(14,2)::text AS paid,
               COALESCE(sum(b.amount_credited) FILTER (WHERE i.status <> 'void'), 0)::numeric(14,2)::text AS credited,
               COALESCE(sum(b.amount_due) FILTER (WHERE ${OPEN_ISSUED}), 0)::numeric(14,2)::text AS outstanding,
               COALESCE(sum(b.amount_due) FILTER (WHERE ${OPEN_ISSUED} AND i.due_date < ${TODAY}), 0)::numeric(14,2)::text AS overdue,
               (SELECT COALESCE(sum(e.amount), 0)::numeric(14,2)::text FROM expenses e
                 WHERE e.matter_id = ${matterId} AND e.status = 'recorded' AND e.billable_to_client) AS "unbilledExpenses"
        FROM matters m
        JOIN organizations o ON o.id = m.organization_id
        LEFT JOIN invoices i ON i.matter_id = m.id
        LEFT JOIN v_invoice_balances b ON b.invoice_id = i.id
        WHERE m.id = ${matterId} AND m.organization_id = ${ctx.organizationId}`,
  );
  return r as MatterBillingDto;
}

export async function clientBalance(
  deps: Deps,
  ctx: TenantContext,
  clientId: string,
): Promise<ClientBalanceDto> {
  const exists = await queryOne(
    deps.pool,
    sql`SELECT 1 FROM clients WHERE id = ${clientId} AND organization_id = ${ctx.organizationId}`,
  );
  if (!exists) throw notFound('Client');
  const r = await queryOne<{ outstanding: string; overdue: string }>(
    deps.pool,
    sql`SELECT COALESCE(sum(b.amount_due) FILTER (WHERE ${OPEN_ISSUED}), 0)::numeric(14,2)::text AS outstanding,
               COALESCE(sum(b.amount_due) FILTER (WHERE ${OPEN_ISSUED} AND i.due_date < ${TODAY}), 0)::numeric(14,2)::text AS overdue
        FROM invoices i JOIN v_invoice_balances b ON b.invoice_id = i.id JOIN organizations o ON o.id = i.organization_id
        WHERE i.organization_id = ${ctx.organizationId} AND i.client_id = ${clientId} AND ${invoiceVisible(ctx)}`,
  );
  const advance = seesAllMatters(ctx.role)
    ? (await queryOne<{ s: string }>(
        deps.pool,
        sql`SELECT COALESCE(sum(unallocated_amount), 0)::numeric(14,2)::text AS s FROM v_payment_unallocated WHERE client_id = ${clientId}`,
      ))!.s
    : '0.00';
  return { outstanding: r!.outstanding, overdue: r!.overdue, advance };
}
