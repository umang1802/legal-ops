import type { PaymentLinkDto, PaymentLinkStatus, ZohoPayEnvironment } from '@legalops/types';
import { sql } from '../../db/sql.js';

export type LinkRow = {
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

export const LINK_SELECT = sql`SELECT l.id, l.invoice_id, l.provider_link_id, l.url, l.amount::text, l.currency, l.status, l.expires_at,
                          l.paid_at, p.receipt_number, l.created_at, l.environment
                   FROM payment_links l LEFT JOIN payments p ON p.id = l.payment_id`;

export const toDto = (r: LinkRow): PaymentLinkDto => ({
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
