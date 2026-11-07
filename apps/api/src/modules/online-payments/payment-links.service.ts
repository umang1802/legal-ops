import type { InvoicePaymentLinksDto, PaymentLinkDto } from '@legalops/types';
import { fromPaise, toPaise, type CreatePaymentLinkInput } from '@legalops/validation';
import { randomUUID } from 'node:crypto';
import { cancelPaymentLink, createPaymentLink, ZohoPayError, type ZohoPayCredentials } from '../../integrations/zohopay/client.js';
import { query, queryOne, withTransaction, type Db } from '../../db/pool.js';
import { sql } from '../../db/sql.js';
import type { Deps } from '../../deps.js';
import type { RequestMeta, TenantContext } from '../../http/context.js';
import { AppError, conflict, notFound, validationError } from '../../http/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { getInvoice } from '../billing/invoices.service.js';
import { instalmentStatus } from '../billing/instalments.js';
import { createNotification } from '../notifications/notifications.service.js';
import { orgToday } from '../../http/dates.js';
import { LINK_SELECT, toDto, type LinkRow } from './link-dto.js';
import { loadZohoPay } from './zohopay-config.service.js';

const SELECT = LINK_SELECT;

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
  if (invoice.instalments.length > 0) throw conflict("Use the instalment's link");

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

/**
 * Withdraws a link whose amount is no longer right: cancelled at Zoho first, then marked canceled here (never inside a
 * DB transaction). Throws the Zoho error as-is when Zoho refuses, leaving the row active.
 */
export async function cancelStaleLink(
  deps: Deps,
  credentials: ZohoPayCredentials,
  orgId: string,
  link: { id: string; provider_link_id: string },
  actorUserId: string,
  reason: string,
  fetchImpl: typeof fetch = fetch,
  meta?: RequestMeta,
): Promise<void> {
  await cancelPaymentLink(credentials, link.provider_link_id, fetchImpl);
  await query(
    deps.pool,
    sql`UPDATE payment_links SET status = 'canceled', updated_at = now() WHERE id = ${link.id} AND status = 'active'`,
  );
  await recordAudit(deps.pool, {
    organizationId: orgId,
    actorUserId,
    action: 'payment_link.canceled',
    entityType: 'payment_link',
    entityId: link.id,
    before: { status: 'active' },
    after: { status: 'canceled', reason },
    ...(meta ? { meta } : {}),
  });
}

/**
 * Best effort, after the invoice is closed (void, write-off): withdraws every open link of the invoice, whole-invoice
 * and per-instalment, at Zoho. Never throws: a link Zoho won't cancel stays active and is logged; the webhook still
 * matches it if the client pays anyway.
 */
export async function cancelInvoiceLinksBestEffort(
  deps: Deps,
  orgId: string,
  invoiceId: string,
  actorUserId: string,
  reason: string,
  meta?: RequestMeta,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    const links = await query<{ id: string; provider_link_id: string }>(
      deps.pool,
      sql`SELECT id, provider_link_id FROM payment_links WHERE organization_id = ${orgId} AND invoice_id = ${invoiceId} AND status = 'active'`,
    );
    if (links.length === 0) return;
    const cfg = await loadZohoPay(deps, deps.pool, orgId);
    if (!cfg) {
      deps.log.warn({ invoiceId, links: links.length }, 'payment links left open: online payments are not configured');
      return;
    }
    for (const l of links) {
      try {
        await cancelStaleLink(deps, cfg.credentials, orgId, l, actorUserId, reason, fetchImpl, meta);
      } catch (err) {
        deps.log.warn({ err, invoiceId, linkId: l.id }, 'payment link could not be cancelled');
      }
    }
  } catch (err) {
    deps.log.warn({ err, invoiceId }, 'payment links could not be withdrawn');
  }
}

const OPEN_INSTALMENT_LINK = (instalmentId: string) =>
  sql`${SELECT} WHERE l.instalment_id = ${instalmentId} AND l.status = 'active'`;

/**
 * The payable link for one instalment, for what is still owed on it. Reuses the open link when its amount still
 * matches; otherwise the old one is cancelled at Zoho and a new one issued. Null when online payments are off or
 * there is nothing left to pay. Zoho is never called inside a transaction; the partial unique index on
 * `payment_links(instalment_id) WHERE active` settles races, and the loser withdraws its own Zoho link.
 */
export async function ensureInstalmentLink(
  deps: Deps,
  orgId: string,
  instalmentId: string,
  actorUserId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PaymentLinkDto | null> {
  const cfg = await loadZohoPay(deps, deps.pool, orgId);
  if (!cfg?.enabled) return null;

  const inst = await queryOne<{
    invoice_id: string;
    client_id: string;
    status: string;
    currency: string;
    invoice_number: string | null;
    due_date: string;
  }>(
    deps.pool,
    sql`SELECT ii.invoice_id, i.client_id, i.status, i.currency, i.invoice_number, ii.due_date::text
        FROM invoice_instalments ii JOIN invoices i ON i.id = ii.invoice_id
        WHERE ii.id = ${instalmentId} AND ii.organization_id = ${orgId}`,
  );
  if (!inst) throw notFound('Instalment');
  if (inst.status !== 'issued' || inst.currency !== 'INR') return null;

  const today = await orgToday(deps.pool, orgId);
  const status = (await instalmentStatus(deps.pool, inst.invoice_id, today)).find((i) => i.id === instalmentId);
  if (!status) throw notFound('Instalment');
  const remaining = toPaise(status.remaining);
  if (remaining <= 0) return null;
  const amount = fromPaise(remaining);

  const open = await queryOne<LinkRow>(deps.pool, OPEN_INSTALMENT_LINK(instalmentId));
  if (open && toPaise(open.amount) === remaining) return toDto(open);
  if (open) {
    try {
      await cancelStaleLink(deps, cfg.credentials, orgId, open, actorUserId, 'instalment amount changed', fetchImpl);
    } catch (err) {
      return asAppError(err);
    }
  }

  const ctxRow = await queryOne<{ firm: string; email: string | null; expires: string }>(
    deps.pool,
    sql`SELECT o.name AS firm, c.email::text AS email,
               (GREATEST((now() AT TIME ZONE o.timezone)::date, ${inst.due_date}::date) + 7)::text AS expires
        FROM organizations o JOIN clients c ON c.id = ${inst.client_id} WHERE o.id = ${orgId}`,
  );
  if (!ctxRow) throw notFound('Invoice');

  const id = randomUUID();
  let link;
  try {
    link = await createPaymentLink(
      cfg.credentials,
      {
        amount,
        currency: inst.currency,
        description:
          `Invoice ${inst.invoice_number ?? ''} instalment ${status.seq} – ${ctxRow.firm}`.replace(/\s+/g, ' ').trim(),
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
      sql`INSERT INTO payment_links (id, organization_id, invoice_id, instalment_id, client_id, provider, environment, provider_link_id,
                                     url, amount, currency, expires_at, created_by)
          VALUES (${id}, ${orgId}, ${inst.invoice_id}, ${instalmentId}, ${inst.client_id}, 'zohopay', ${cfg.credentials.environment},
                  ${link.payment_link_id}, ${link.url}, ${amount}, ${inst.currency}, ${link.expires_at ?? ctxRow.expires}, ${actorUserId})`,
    );
  } catch (err) {
    // Lost a race with another caller: take our extra Zoho link back and hand out the winner's.
    await cancelPaymentLink(cfg.credentials, link.payment_link_id, fetchImpl).catch(() => undefined);
    if ((err as { code?: string }).code === '23505') {
      const winner = await queryOne<LinkRow>(deps.pool, OPEN_INSTALMENT_LINK(instalmentId));
      if (winner) return toDto(winner);
    }
    throw err;
  }
  await recordAudit(deps.pool, {
    organizationId: orgId,
    actorUserId,
    action: 'payment_link.created',
    entityType: 'payment_link',
    entityId: id,
    after: {
      invoiceId: inst.invoice_id,
      instalmentId,
      amount,
      providerLinkId: link.payment_link_id,
      environment: cfg.credentials.environment,
    },
  });
  return toDto((await queryOne<LinkRow>(deps.pool, sql`${SELECT} WHERE l.id = ${id}`))!);
}

/** "Send now": e-mails the client this instalment's payment link immediately (queued; the worker sends it). */
export async function sendInstalmentNow(
  deps: Deps,
  ctx: TenantContext,
  invoiceId: string,
  seq: number,
  meta: RequestMeta,
): Promise<{ notificationId: string }> {
  const invoice = await getInvoice(deps.pool, ctx, invoiceId);
  if (invoice.status !== 'issued' || !invoice.sentAt)
    throw conflict('Send the invoice to the client before sending an instalment link');
  const inst = invoice.instalments.find((i) => i.seq === seq);
  if (!inst) throw notFound('Instalment');
  if (inst.status === 'paid') throw conflict('This instalment is already paid');

  const client = await queryOne<{ email: string | null }>(
    deps.pool,
    sql`SELECT email::text AS email FROM clients WHERE id = ${invoice.client.id} AND organization_id = ${ctx.organizationId}`,
  );
  if (!client?.email?.trim()) throw conflict('Client has no email address');

  const link = await ensureInstalmentLink(deps, ctx.organizationId, inst.id, ctx.userId);
  if (!link) throw notConfigured();

  const n = await withTransaction(deps.pool, async (tx) => {
    const created = await createNotification(tx, deps.env.APP_URL, {
      organizationId: ctx.organizationId,
      templateKey: 'instalment_payment_link',
      recipient: { type: 'client', clientId: invoice.client.id },
      refs: { invoiceId, instalmentId: inst.id, clientId: invoice.client.id },
      now: new Date(),
      createdBy: ctx.userId,
      idempotencyKey: `send-now:${inst.id}:${meta.requestId}`,
    });
    if (created.created && created.status === 'queued') {
      await query(tx, sql`UPDATE invoice_instalments SET emailed_at = now() WHERE id = ${inst.id}`);
    }
    if (created.created)
      await recordAudit(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        action: 'invoice.instalment_link_sent',
        entityType: 'invoice',
        entityId: invoiceId,
        after: { seq, notificationId: created.id },
        meta,
      });
    return created;
  });
  return { notificationId: n.id };
}
