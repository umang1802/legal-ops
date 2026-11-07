import {
  invoiceFormatSchema,
  resolveInvoiceFormat,
  type InvoiceFormat,
  type InvoiceFormatInput,
} from '@legalops/validation';
import type { WireDocModel } from '@legalops/types';
import { query, queryOne, withTransaction, type Db } from '../../db/pool.js';
import { sql } from '../../db/sql.js';
import type { Deps } from '../../deps.js';
import type { RequestMeta, TenantContext } from '../../http/context.js';
import { notFound } from '../../http/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { invoiceDocumentModel, loadLetterhead, sampleInvoiceDocData } from '../billing/pdf/invoice-pdf.js';
import { toWireModel } from '../billing/pdf/wire.js';

export type InvoiceFormatDto = { format: InvoiceFormat; isDefault: boolean };

/** The firm's complete format: what is stored, filled in with the standard format wherever it is silent. */
export async function loadInvoiceFormat(db: Db, organizationId: string): Promise<InvoiceFormatDto> {
  const row = await queryOne<{ f: unknown }>(
    db,
    sql`SELECT invoice_format AS f FROM organizations WHERE id = ${organizationId}`,
  );
  if (!row) throw notFound('Organization');
  return { format: resolveInvoiceFormat(row.f), isDefault: row.f == null };
}

export async function saveInvoiceFormat(
  deps: Deps,
  ctx: TenantContext,
  input: InvoiceFormatInput,
  meta: RequestMeta,
): Promise<InvoiceFormatDto> {
  const format = invoiceFormatSchema.parse(input); // already validated by the route; this also applies the defaults
  await withTransaction(deps.pool, async (tx) => {
    const before = await queryOne<{ f: unknown }>(
      tx,
      sql`SELECT invoice_format AS f FROM organizations WHERE id = ${ctx.organizationId} FOR UPDATE`,
    );
    if (!before) throw notFound('Organization');
    await query(
      tx,
      sql`UPDATE organizations SET invoice_format = ${JSON.stringify(format)}::jsonb WHERE id = ${ctx.organizationId}`,
    );
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'organization.invoice_format_updated',
      entityType: 'organization',
      entityId: ctx.organizationId,
      before: { wasDefault: before.f == null },
      after: {
        sections: format.sections,
        watermark: format.watermark.mode,
        currencyStyle: format.currencyStyle,
      },
      meta,
    });
  });
  return { format, isDefault: false };
}

/** Back to the standard format. */
export async function resetInvoiceFormat(
  deps: Deps,
  ctx: TenantContext,
  meta: RequestMeta,
): Promise<InvoiceFormatDto> {
  await withTransaction(deps.pool, async (tx) => {
    await query(tx, sql`UPDATE organizations SET invoice_format = NULL WHERE id = ${ctx.organizationId}`);
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'organization.invoice_format_reset',
      entityType: 'organization',
      entityId: ctx.organizationId,
      meta,
    });
  });
  return loadInvoiceFormat(deps.pool, ctx.organizationId);
}

/** A sample invoice in the draft format (not saved), drawn with the firm's real letterhead, logo and bank details. */
export async function previewInvoiceFormat(
  deps: Deps,
  ctx: TenantContext,
  input: InvoiceFormatInput,
): Promise<WireDocModel> {
  const format = invoiceFormatSchema.parse(input);
  const today = (
    await queryOne<{ d: string }>(
      deps.pool,
      sql`SELECT ((now() AT TIME ZONE timezone)::date)::text AS d FROM organizations WHERE id = ${ctx.organizationId}`,
    )
  )?.d;
  if (!today) throw notFound('Organization');
  const letterhead = await loadLetterhead(deps, deps.pool, ctx.organizationId);
  return toWireModel(invoiceDocumentModel(sampleInvoiceDocData(letterhead, format, today), format));
}
