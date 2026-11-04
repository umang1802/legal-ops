import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Zoho Payments webhook signature (docs: "Verifying Webhooks"). The X-Zoho-Webhook-Signature header looks like
 * `t=<epoch ms>,v=<hex>`; v is HMAC-SHA256 over `<t>.<raw request body>` with the webhook's signing key.
 * No timestamp tolerance on purpose: Zoho retries failed deliveries for days, so replay is handled by event id instead.
 */
export function verifyZohoWebhook(rawBody: Buffer, header: string | undefined, signingKey: string): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  ) as Record<string, string | undefined>;
  const { t, v } = parts;
  if (!t || !v || !/^[0-9a-fA-F]+$/.test(v)) return false;
  const expected = createHmac('sha256', signingKey).update(`${t}.`).update(rawBody).digest();
  const actual = Buffer.from(v, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** For tests and local simulation: builds a header the way Zoho does. */
export function signZohoWebhook(rawBody: Buffer | string, signingKey: string, t = Date.now()): string {
  const digest = createHmac('sha256', signingKey).update(`${t}.`).update(rawBody).digest('hex');
  return `t=${t},v=${digest}`;
}
