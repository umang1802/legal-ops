import type { ZohoPayEnvironment } from '@legalops/types';

/** Credentials for one firm's Zoho Payments account, already decrypted. Never log or return this. */
export type ZohoPayCredentials = {
  environment: ZohoPayEnvironment;
  accountId: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

export type ZohoPaymentLink = {
  payment_link_id: string;
  url: string;
  amount: string;
  amount_paid?: string;
  currency: string;
  status: string;
  expires_at?: string;
  reference_id?: string;
};

export class ZohoPayError extends Error {
  constructor(
    message: string,
    /** True when retrying later can help (network trouble, 5xx, rate limit); false for bad credentials or input. */
    readonly transient: boolean,
  ) {
    super(message);
  }
}

// India data centre. Sandbox uses a separate API host; sign-in (OAuth) is always on accounts.zoho.in.
const ACCOUNTS = 'https://accounts.zoho.in';
const API = {
  live: 'https://payments.zoho.in/api/v1',
  sandbox: 'https://paymentssandbox.zoho.in/api/v1',
} as const;

type Fetch = typeof fetch;
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const cacheKey = (c: ZohoPayCredentials) =>
  `${c.environment}:${c.accountId}:${c.clientId}:${c.refreshToken.slice(-8)}`;

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

/** Exchanges the stored refresh token for a short-lived access token (about an hour). Cached per account. */
export async function getAccessToken(
  c: ZohoPayCredentials,
  fetchImpl: Fetch = fetch,
  now = Date.now(),
): Promise<string> {
  const hit = tokenCache.get(cacheKey(c));
  if (hit && hit.expiresAt > now + 60_000) return hit.token;
  const body = new URLSearchParams({
    refresh_token: c.refreshToken,
    client_id: c.clientId,
    client_secret: c.clientSecret,
    grant_type: 'refresh_token',
  });
  let res: Response;
  try {
    res = await fetchImpl(`${ACCOUNTS}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch {
    throw new ZohoPayError('Could not reach Zoho to sign in. Try again in a moment.', true);
  }
  const json = await readJson(res);
  const token = typeof json.access_token === 'string' ? json.access_token : null;
  if (!res.ok || !token) {
    // Zoho answers 200 with {"error":"invalid_client"} for bad credentials; the code is safe to show, never the secrets.
    const code = typeof json.error === 'string' ? json.error : `HTTP ${res.status}`;
    throw new ZohoPayError(
      `Zoho rejected the credentials (${code}). Check the client ID, client secret and refresh token.`,
      res.status >= 500 || res.status === 429,
    );
  }
  const ttl = typeof json.expires_in === 'number' ? json.expires_in : 3600;
  tokenCache.set(cacheKey(c), { token, expiresAt: now + ttl * 1000 });
  return token;
}

export function forgetAccessToken(c: ZohoPayCredentials): void {
  tokenCache.delete(cacheKey(c));
}

async function api<T>(
  c: ZohoPayCredentials,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body: unknown,
  fetchImpl: Fetch,
): Promise<T> {
  const token = await getAccessToken(c, fetchImpl);
  let res: Response;
  try {
    res = await fetchImpl(`${API[c.environment]}${path}?account_id=${encodeURIComponent(c.accountId)}`, {
      method,
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ZohoPayError('Could not reach Zoho Payments. Try again in a moment.', true);
  }
  const json = await readJson(res);
  if (res.status === 401) forgetAccessToken(c);
  if (!res.ok || (typeof json.code === 'number' && json.code !== 0)) {
    const msg = typeof json.message === 'string' ? json.message : `HTTP ${res.status}`;
    throw new ZohoPayError(`Zoho Payments said: ${msg}`, res.status >= 500 || res.status === 429);
  }
  return json as T;
}

export type CreateLinkInput = {
  amount: string; // decimal rupees, e.g. "1500.00"
  currency: string;
  description: string;
  referenceId: string; // alphanumeric, max 100
  expiresAt: string; // yyyy-MM-dd
  email?: string | null;
  phone?: string | null;
};

export async function createPaymentLink(
  c: ZohoPayCredentials,
  input: CreateLinkInput,
  fetchImpl: Fetch = fetch,
): Promise<ZohoPaymentLink> {
  const json = await api<{ payment_links: ZohoPaymentLink }>(
    c,
    'POST',
    '/paymentlinks',
    {
      amount: Number(input.amount),
      currency: input.currency,
      description: input.description.slice(0, 500),
      reference_id: input.referenceId,
      expires_at: input.expiresAt,
      ...(input.email ? { email: input.email } : {}),
      ...(input.phone ? { phone: input.phone } : {}),
      // We hand the link over ourselves; Zoho does not message the client on the firm's behalf.
      notify_customer: { email: false, sms: false },
    },
    fetchImpl,
  );
  if (!json.payment_links?.payment_link_id || !json.payment_links.url)
    throw new ZohoPayError('Zoho Payments returned no payment link.', false);
  return json.payment_links;
}

export async function cancelPaymentLink(
  c: ZohoPayCredentials,
  providerLinkId: string,
  fetchImpl: Fetch = fetch,
): Promise<void> {
  await api(c, 'PUT', `/paymentlinks/${encodeURIComponent(providerLinkId)}/cancel`, undefined, fetchImpl);
}
