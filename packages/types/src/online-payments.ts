import type { Money } from './dtos.js';

export type ZohoPayEnvironment = 'sandbox' | 'live';

/** What the platform console sees. Secrets are never returned: only whether each one is on file. */
export type ZohoPayConfigDto = {
  configured: boolean;
  enabled: boolean;
  environment: ZohoPayEnvironment;
  accountId: string | null;
  clientId: string | null;
  hasClientSecret: boolean;
  hasRefreshToken: boolean;
  hasSigningKey: boolean;
  /** Where to point the Zoho Payments webhook for this firm. */
  webhookUrl: string;
  /** Zoho events this firm's webhook must be subscribed to. */
  webhookEvents: readonly string[];
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  updatedAt: string | null;
};

export const ZOHOPAY_WEBHOOK_EVENTS = [
  'payment_link.paid',
  'payment_link.expired',
  'payment_link.canceled',
] as const;

export type PaymentLinkStatus = 'active' | 'paid' | 'expired' | 'canceled';

export type PaymentLinkDto = {
  id: string;
  invoiceId: string;
  url: string;
  amount: Money;
  currency: string;
  status: PaymentLinkStatus;
  expiresAt: string | null;
  paidAt: string | null;
  receiptNumber: string | null;
  createdAt: string;
  environment: ZohoPayEnvironment;
};

/** Per-invoice view: whether the firm can take online payments, and the links made so far. */
export type InvoicePaymentLinksDto = { enabled: boolean; links: PaymentLinkDto[] };
