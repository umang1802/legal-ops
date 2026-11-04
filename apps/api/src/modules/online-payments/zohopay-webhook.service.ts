import { FEATURE_KEYS, type PaymentMethod } from '@legalops/types';
import { fromPaise, recordPaymentSchema, toPaise } from '@legalops/validation';
import type { PoolClient } from 'pg';
import { verifyZohoWebhook } from '../../integrations/zohopay/signature.js';
import { query, queryOne, withTransaction } from '../../db/pool.js';
import { sql } from '../../db/sql.js';
import type { Deps } from '../../deps.js';
import type { TenantContext } from '../../http/context.js';
import { recordAudit } from '../audit/audit.service.js';
import { getInvoice } from '../billing/invoices.service.js';
import { recordPayment } from '../billing/payments.service.js';
import { loadZohoPay } from './zohopay-config.service.js';

type ZohoEvent = {
  event_id?: number | string;
  event_type?: string;
  account_id?: number | string;
  live_mode?: boolean;
  event_object?: {
    payment_links?: {
      payment_link_id?: string;
      amount_paid?: string;
      reference_id?: string;
      payments?: { payment_id?: string; type?: string; status?: string; date?: number }[];
    };
  };
};

export type WebhookResult = { http: 200 | 400 | 401; message: string };

// Zoho's payment types -> the methods the ledger knows. Net banking is a bank transfer to the firm's account.
const METHOD: Record<string, PaymentMethod> = { upi: 'upi', card: 'card', net_banking: 'bank_transfer' };

/**
 * Handles one Zoho Payments webhook for a firm. Order matters: the signature is checked first, against the signing
 * key stored for THIS firm, before anything in the body is trusted. Everything after that runs in one transaction,
 * so the event record, the receipt and the link status either all happen or none do (Zoho then retries).
 */
export async function handleZohoWebhook(
  deps: Deps,
  organizationId: string,
  rawBody: Buffer,
  signature: string | undefined,
): Promise<WebhookResult> {
  const cfg = await loadZohoPay(deps, deps.pool, organizationId);
  // Same answer for "unknown firm", "not set up" and "bad signature": nothing to learn by probing.
  if (!cfg?.signingKey || !verifyZohoWebhook(rawBody, signature, cfg.signingKey))
    return { http: 401, message: 'Invalid signature' };

  let event: ZohoEvent;
  try {
    event = JSON.parse(rawBody.toString('utf8')) as ZohoEvent;
  } catch {
    return { http: 400, message: 'Body is not JSON' };
  }
  const eventId = event.event_id !== undefined ? String(event.event_id) : null;
  const eventType = event.event_type;
  if (!eventId || !eventType) return { http: 400, message: 'Missing event id or type' };

  const ignore = async (why: string): Promise<WebhookResult> => {
    deps.log.warn({ organizationId, eventId, eventType, why }, 'zoho webhook ignored');
    return { http: 200, message: `Ignored: ${why}` };
  };
  if (String(event.account_id ?? '') !== cfg.credentials.accountId) return ignore('account mismatch');
  if ((event.live_mode === true) !== (cfg.credentials.environment === 'live'))
    return ignore('environment mismatch');

  const message = await withTransaction(deps.pool, async (tx): Promise<string> => {
    const fresh = await queryOne<{ id: string }>(
      tx,
      sql`INSERT INTO payment_gateway_events (organization_id, provider, event_id, event_type)
          VALUES (${organizationId}, 'zohopay', ${eventId}, ${eventType}) ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`,
    );
    if (!fresh) return 'Duplicate event';

    const outcome = await apply(deps, tx, organizationId, eventType, event);
    await query(
      tx,
      sql`UPDATE payment_gateway_events SET result = ${outcome.slice(0, 300)} WHERE id = ${fresh.id}`,
    );
    return outcome;
  });
  return { http: 200, message };
}

async function apply(
  deps: Deps,
  tx: PoolClient,
  organizationId: string,
  eventType: string,
  event: ZohoEvent,
): Promise<string> {
  if (!['payment_link.paid', 'payment_link.expired', 'payment_link.canceled'].includes(eventType))
    return 'Event type not handled';
  const pl = event.event_object?.payment_links;
  if (!pl?.payment_link_id) return 'No payment link in event';

  const link = await queryOne<{
    id: string;
    invoice_id: string;
    client_id: string;
    status: string;
    created_by: string;
    amount: string;
    provider_link_id: string;
  }>(
    tx,
    sql`SELECT id, invoice_id, client_id, status, created_by, amount::text, provider_link_id FROM payment_links
        WHERE organization_id = ${organizationId} AND provider = 'zohopay' AND provider_link_id = ${pl.payment_link_id} FOR UPDATE`,
  );
  if (!link) return 'Unknown payment link';

  if (eventType === 'payment_link.expired' || eventType === 'payment_link.canceled') {
    const next = eventType === 'payment_link.expired' ? 'expired' : 'canceled';
    await query(
      tx,
      sql`UPDATE payment_links SET status = ${next}, updated_at = now() WHERE id = ${link.id} AND status = 'active'`,
    );
    return `Link marked ${next}`;
  }

  // payment_link.paid
  if (link.status === 'paid') return 'Link already paid';
  const paidPaise = pl.amount_paid ? toPaise(pl.amount_paid) : 0;
  if (paidPaise <= 0) return 'Paid event carried no amount';
  const zohoPayment = pl.payments?.find((p) => p.status === 'succeeded') ?? pl.payments?.[0];

  // The firm's own person who created the link is the recorder; the receipt reads as theirs, flagged as online.
  const ctx: TenantContext = {
    userId: link.created_by,
    organizationId,
    role: 'owner',
    features: FEATURE_KEYS,
  };
  const invoice = await getInvoice(tx, ctx, link.invoice_id);
  // If the bill was settled, voided or reduced while the link was open, the money still arrived: keep it as an advance.
  const duePaise = invoice.status === 'issued' ? Math.max(toPaise(invoice.amountDue), 0) : 0;
  const applied = Math.min(paidPaise, duePaise);

  const dateRow = await queryOne<{ d: string }>(
    tx,
    sql`SELECT ((${zohoPayment?.date ? sql`to_timestamp(${zohoPayment.date})` : sql`now()`}) AT TIME ZONE o.timezone)::date::text AS d
        FROM organizations o WHERE o.id = ${organizationId}`,
  );
  const payment = await recordPayment(
    deps,
    ctx,
    recordPaymentSchema.parse({
      clientId: link.client_id,
      matterId: invoice.matter.id,
      amount: fromPaise(paidPaise),
      paymentDate: dateRow!.d,
      method: METHOD[zohoPayment?.type ?? ''] ?? 'other',
      referenceNumber: zohoPayment?.payment_id ?? link.provider_link_id,
      notes: `Paid online through Zoho Payments (payment link ${link.provider_link_id})`,
      allocations: applied > 0 ? [{ invoiceId: link.invoice_id, amount: fromPaise(applied) }] : [],
      keepRemainderAsAdvance: paidPaise > applied,
    }),
    { requestId: `zohopay:${link.provider_link_id}`, ip: null, userAgent: 'zohopay-webhook' },
    tx,
  );
  await query(
    tx,
    sql`UPDATE payment_links SET status = 'paid', paid_at = now(), payment_id = ${payment.id}, provider_payment_id = ${zohoPayment?.payment_id ?? null},
               updated_at = now() WHERE id = ${link.id}`,
  );
  await recordAudit(tx, {
    organizationId,
    actorUserId: null,
    actorType: 'system',
    action: 'payment_link.paid',
    entityType: 'payment_link',
    entityId: link.id,
    after: {
      invoiceId: link.invoice_id,
      amount: fromPaise(paidPaise),
      paymentId: payment.id,
      appliedToInvoice: fromPaise(applied),
    },
  });
  return applied < paidPaise
    ? `Receipt ${payment.receiptNumber} recorded; ${fromPaise(paidPaise - applied)} kept as advance`
    : `Receipt ${payment.receiptNumber} recorded`;
}
