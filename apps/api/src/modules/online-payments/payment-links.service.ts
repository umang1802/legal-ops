import type {
  InvoicePaymentLinksDto,
  PaymentLinkDto,
  PaymentLinkStatus,
  ZohoPayEnvironment,
} from '@legalops/types';
import { fromPaise, toPaise, type CreatePaymentLinkInput } from '@legalops/validation';
import { randomUUID } from 'node:crypto';
import { cancelPaymentLink, createPaymentLink, ZohoPayError } from '../../integrations/zohopay/client.js';
import { query, queryOne, type Db } from '../../db/pool.js';
import { sql } from '../../db/sql.js';
import type { Deps } from '../../deps.js';
import type { RequestMeta, TenantContext } from '../../http/context.js';
import { AppError, conflict, notFound, validationError } from '../../http/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { getInvoice } from '../billing/invoices.service.js';
import { loadZohoPay } from './zohopay-config.service.js';

type LinkRow = {
  id: string;
  invoice_id: string;
  provider_link_id: string;
  url: string;
  amount: string;
  currency: string;
  status: PaymentLinkStatus;
  expires_at: string | null;
  paid_at: Date | null;
  receipt_number: string | null;
  created_at: Date;
  environment: ZohoPayEnvironment;
};

const SELECT = sql`SELECT l.id, l.invoice_id, l.provider_link_id, l.url, l.amount::text, l.currency, l.status, l.expires_at,
                          l.paid_at, p.receipt_number, l.created_at, l.environment
                   FROM payment_links l LEFT JOIN payments p ON p.id = l.payment_id`;

const toDto = (r: LinkRow): PaymentLinkDto => ({
  id: r.id,
  invoiceId: r.invoice_id,
  url: r.url,
  amount: r.amount,
  currency: r.currency,
  status: r.status,
  expiresAt: r.expires_at,
  paidAt: r.paid_at?.toISOString() ?? null,
  receiptNumber: r.receipt_number,
  createdAt: r.created_at.toISOString(),
  environment: r.environment,
});

const notConfigured = () =>
  new AppError(
    409,
    'NOT_CONFIGURED',
    'Online payments aren’t switched on for your firm yet. Ask LexForgeX to set them up.',
  );

/** A Zoho failure the user can act on: say what happened without exposing anything internal. */
const asAppError = (err: unknown): never => {
  if (err instanceof ZohoPayError)
    throw new AppError(
      err.transient ? 503 : 422,
      err.transient ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR',
      err.message,
    );
  throw err;
};

export async function listInvoicePaymentLinks(
  db: Db,
  deps: Deps,
  ctx: TenantContext,
  invoiceId: string,
): Promise<InvoicePaymentLinksDto> {
  await getInvoice(db, ctx, invoiceId); // 404 when the invoice isn't visible to this user
  const cfg = await loadZohoPay(deps, db, ctx.organizationId);
  const rows = await query<LinkRow>(
    db,
    sql`${SELECT} WHERE l.organization_id = ${ctx.organizationId} AND l.invoice_id = ${invoiceId} ORDER BY l.created_at DESC LIMIT 20`,
  );
  return { enabled: Boolean(cfg?.enabled), links: rows.map(toDto) };
}

export async function createInvoicePaymentLink(
  deps: Deps,
  ctx: TenantContext,
  invoiceId: string,
  input: CreatePaymentLinkInput,
  meta: RequestMeta,
  fetchImpl: typeof fetch = fetch,
): Promise<PaymentLinkDto> {
  const cfg = await loadZohoPay(deps, deps.pool, ctx.organizationId);
  if (!cfg?.enabled) throw notConfigured();

  const invoice = await getInvoice(deps.pool, ctx, invoiceId);
  if (invoice.status !== 'issued') throw conflict('Only an issued invoice can be paid online');
  const duePaise = toPaise(invoice.amountDue);
  if (duePaise <= 0) throw conflict('This invoice has nothing left to pay');
  const amountPaise = input.amount ? toPaise(input.amount) : duePaise;
  if (amountPaise > duePaise)
    throw validationError('That is more than the amount due', [
      { path: 'amount', message: `At most ${invoice.amountDue}` },
    ]);
  if (invoice.currency !== 'INR') throw conflict('Online payments support INR invoices only');

  const open = await queryOne<{ id: string }>(
    deps.pool,
    sql`SELECT id FROM payment_links WHERE invoice_id = ${invoiceId} AND status = 'active'`,
  );
  if (open) throw conflict('This invoice already has an open payment link. Use it, or cancel it first.');

  const ctxRow = await queryOne<{ firm: string; email: string | null; expires: string }>(
    deps.pool,
    sql`SELECT o.name AS firm, c.email::text AS email,
               (((now() AT TIME ZONE o.timezone)::date) + ${input.expiresInDays}::int)::text AS expires
        FROM organizations o JOIN clients c ON c.id = ${invoice.client.id} WHERE o.id = ${ctx.organizationId}`,
  );
  if (!ctxRow) throw notFound('Invoice');

  const id = randomUUID();
  const amount = fromPaise(amountPaise);
  let link;
  try {
    link = await createPaymentLink(
      cfg.credentials,
      {
        amount,
        currency: invoice.currency,
        description: `Invoice ${invoice.invoiceNumber ?? ''} – ${ctxRow.firm}`.replace(/\s+/g, ' ').trim(),
        referenceId: id.replaceAll('-', ''),
        expiresAt: ctxRow.expires,
        email: ctxRow.email,
      },
      fetchImpl,
    );
  } catch (err) {
    return asAppError(err);
  }

  try {
    await query(
      deps.pool,
      sql`INSERT INTO payment_links (id, organization_id, invoice_id, client_id, provider, environment, provider_link_id, url, amount,
                                     currency, expires_at, created_by)
          VALUES (${id}, ${ctx.organizationId}, ${invoiceId}, ${invoice.client.id}, 'zohopay', ${cfg.credentials.environment},
                  ${link.payment_link_id}, ${link.url}, ${amount}, ${invoice.currency}, ${link.expires_at ?? ctxRow.expires}, ${ctx.userId})`,
    );
  } catch (err) {
    // Lost a race with another click: take the extra Zoho link back so the client can't pay twice.
    await cancelPaymentLink(cfg.credentials, link.payment_link_id, fetchImpl).catch(() => undefined);
    if ((err as { code?: string }).code === '23505')
      throw conflict('This invoice already has an open payment link. Use it, or cancel it first.');
    throw err;
  }
  await recordAudit(deps.pool, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'payment_link.created',
    entityType: 'payment_link',
    entityId: id,
    after: {
      invoiceId,
      amount,
      providerLinkId: link.payment_link_id,
      environment: cfg.credentials.environment,
    },
    meta,
  });
  const row = await queryOne<LinkRow>(deps.pool, sql`${SELECT} WHERE l.id = ${id}`);
  return toDto(row!);
}

export async function cancelInvoicePaymentLink(
  deps: Deps,
  ctx: TenantContext,
  invoiceId: string,
  linkId: string,
  meta: RequestMeta,
  fetchImpl: typeof fetch = fetch,
): Promise<PaymentLinkDto> {
  await getInvoice(deps.pool, ctx, invoiceId);
  const row = await queryOne<LinkRow>(
    deps.pool,
    sql`${SELECT} WHERE l.id = ${linkId} AND l.invoice_id = ${invoiceId} AND l.organization_id = ${ctx.organizationId}`,
  );
  if (!row) throw notFound('Payment link');
  if (row.status !== 'active') throw conflict(`This link is already ${row.status}`);
  const cfg = await loadZohoPay(deps, deps.pool, ctx.organizationId);
  if (!cfg) throw notConfigured();
  try {
    await cancelPaymentLink(cfg.credentials, row.provider_link_id, fetchImpl);
  } catch (err) {
    return asAppError(err);
  }
  await query(
    deps.pool,
    sql`UPDATE payment_links SET status = 'canceled', updated_at = now() WHERE id = ${linkId} AND status = 'active'`,
  );
  await recordAudit(deps.pool, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'payment_link.canceled',
    entityType: 'payment_link',
    entityId: linkId,
    before: { status: 'active' },
    after: { status: 'canceled' },
    meta,
  });
  return toDto((await queryOne<LinkRow>(deps.pool, sql`${SELECT} WHERE l.id = ${linkId}`))!);
}
