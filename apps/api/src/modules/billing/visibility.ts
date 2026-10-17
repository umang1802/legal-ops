import { seesAllMatters } from '@legalops/types';
import { sql, type SqlFragment } from '../../db/sql.js';
import type { TenantContext } from '../../http/context.js';
import { matterVisible } from '../access/matter-scope.js';

/** Invoices follow their matter (D-004). */
export const invoiceVisible = (ctx: TenantContext, alias = 'i'): SqlFragment =>
  matterVisible(ctx, sql.raw(`${alias}.matter_id`));

/**
 * Payments belong to a client. Firm-wide roles see all; others see payments tied to a matter they
 * can see, or applied to an invoice on such a matter. Unapplied client-level advances stay firm-only.
 */
export function paymentVisible(ctx: TenantContext, alias = 'p'): SqlFragment {
  if (seesAllMatters(ctx.role)) return sql`TRUE`;
  return sql`((${sql.raw(alias)}.matter_id IS NOT NULL AND ${matterVisible(ctx, sql.raw(`${alias}.matter_id`))})
    OR EXISTS (SELECT 1 FROM payment_allocations pv_a JOIN invoices pv_i ON pv_i.id = pv_a.invoice_id
               WHERE pv_a.payment_id = ${sql.raw(alias)}.id AND ${matterVisible(ctx, sql.raw('pv_i.matter_id'))}))`;
}
