import { ZOHOPAY_WEBHOOK_EVENTS, type ZohoPayConfigDto, type ZohoPayEnvironment } from '@legalops/types';
import type { ZohoPayConfigInput } from '@legalops/validation';
import {
  forgetAccessToken,
  getAccessToken,
  ZohoPayError,
  type ZohoPayCredentials,
} from '../../integrations/zohopay/client.js';
import { query, queryOne, withTransaction, type Db } from '../../db/pool.js';
import { sql } from '../../db/sql.js';
import type { Deps } from '../../deps.js';
import type { RequestMeta, PlatformAuth } from '../../http/context.js';
import { conflict, notFound, validationError } from '../../http/errors.js';
import { recordPlatformAudit } from '../platform/platform-auth.service.js';
import { decryptSecret, encryptSecret, platformKey } from '../platform/secrets.js';

type ConfigRow = {
  enabled: boolean;
  environment: ZohoPayEnvironment;
  account_id: string;
  client_id: string;
  client_secret_enc: string;
  refresh_token_enc: string;
  signing_key_enc: string | null;
  last_test_at: Date | null;
  last_test_ok: boolean | null;
  last_test_message: string | null;
  updated_at: Date;
};

const COLUMNS = sql`enabled, environment, account_id, client_id, client_secret_enc, refresh_token_enc, signing_key_enc,
                    last_test_at, last_test_ok, last_test_message, updated_at`;

export const webhookUrl = (deps: Deps, organizationId: string) =>
  `${deps.env.APP_URL.replace(/\/+$/, '')}/api/v1/webhooks/zohopay/${organizationId}`;

async function loadRow(db: Db, organizationId: string, lock = false): Promise<ConfigRow | null> {
  return (
    (await queryOne<ConfigRow>(
      db,
      sql`SELECT ${COLUMNS} FROM organization_payment_gateways
          WHERE organization_id = ${organizationId} AND provider = 'zohopay' ${lock ? sql`FOR UPDATE` : sql.empty}`,
    )) ?? null
  );
}

async function assertFirm(db: Db, organizationId: string): Promise<void> {
  if (!(await queryOne(db, sql`SELECT 1 FROM organizations WHERE id = ${organizationId}`)))
    throw notFound('Firm');
}

function toDto(deps: Deps, organizationId: string, r: ConfigRow | null): ZohoPayConfigDto {
  return {
    configured: r !== null,
    enabled: r?.enabled ?? false,
    environment: r?.environment ?? 'sandbox',
    accountId: r?.account_id ?? null,
    clientId: r?.client_id ?? null,
    hasClientSecret: Boolean(r?.client_secret_enc),
    hasRefreshToken: Boolean(r?.refresh_token_enc),
    hasSigningKey: Boolean(r?.signing_key_enc),
    webhookUrl: webhookUrl(deps, organizationId),
    webhookEvents: ZOHOPAY_WEBHOOK_EVENTS,
    lastTestAt: r?.last_test_at?.toISOString() ?? null,
    lastTestOk: r?.last_test_ok ?? null,
    lastTestMessage: r?.last_test_message ?? null,
    updatedAt: r?.updated_at.toISOString() ?? null,
  };
}

export async function getZohoPayConfig(deps: Deps, organizationId: string): Promise<ZohoPayConfigDto> {
  await assertFirm(deps.pool, organizationId);
  return toDto(deps, organizationId, await loadRow(deps.pool, organizationId));
}

/** Decrypted credentials for server-side use only (creating links, verifying webhooks). Null when not set up. */
export async function loadZohoPay(
  deps: Deps,
  db: Db,
  organizationId: string,
): Promise<{ enabled: boolean; credentials: ZohoPayCredentials; signingKey: string | null } | null> {
  const r = await loadRow(db, organizationId);
  if (!r) return null;
  const key = platformKey(deps.env);
  return {
    enabled: r.enabled,
    credentials: {
      environment: r.environment,
      accountId: r.account_id,
      clientId: r.client_id,
      clientSecret: decryptSecret(key, r.client_secret_enc),
      refreshToken: decryptSecret(key, r.refresh_token_enc),
    },
    signingKey: r.signing_key_enc ? decryptSecret(key, r.signing_key_enc) : null,
  };
}

export async function saveZohoPayConfig(
  deps: Deps,
  auth: PlatformAuth,
  organizationId: string,
  input: ZohoPayConfigInput,
  meta: RequestMeta,
): Promise<ZohoPayConfigDto> {
  const key = platformKey(deps.env);
  await withTransaction(deps.pool, async (tx) => {
    await assertFirm(tx, organizationId);
    const before = await loadRow(tx, organizationId, true);
    const merged = {
      environment: input.environment ?? before?.environment ?? 'sandbox',
      accountId: input.accountId ?? before?.account_id,
      clientId: input.clientId ?? before?.client_id,
      hasSecret: Boolean(input.clientSecret ?? before?.client_secret_enc),
      hasRefresh: Boolean(input.refreshToken ?? before?.refresh_token_enc),
      hasSigningKey: Boolean(input.signingKey ?? before?.signing_key_enc),
    };
    const missing = [
      !merged.accountId && { path: 'accountId', message: 'Enter the Zoho Payments account ID' },
      !merged.clientId && { path: 'clientId', message: 'Enter the OAuth client ID' },
      !merged.hasSecret && { path: 'clientSecret', message: 'Enter the client secret' },
      !merged.hasRefresh && { path: 'refreshToken', message: 'Enter the refresh token' },
    ].filter(Boolean);
    if (missing.length) throw validationError('Some Zoho Payments details are missing', missing);
    // Without the signing key every webhook would be refused, so a payment would never reach the invoice.
    if (input.enabled === true && !merged.hasSigningKey) {
      throw validationError('Add the webhook signing key before turning online payments on', [
        { path: 'signingKey', message: 'Required to turn on' },
      ]);
    }
    const enabled = input.enabled ?? before?.enabled ?? false;
    // Anything that changes which account we talk to, or how we sign in, makes the last test meaningless.
    const authChanged = Boolean(
      input.environment || input.accountId || input.clientId || input.clientSecret || input.refreshToken,
    );

    await query(
      tx,
      sql`INSERT INTO organization_payment_gateways (organization_id, provider, enabled, environment, account_id, client_id,
                                                     client_secret_enc, refresh_token_enc, signing_key_enc, updated_by)
          VALUES (${organizationId}, 'zohopay', ${enabled}, ${merged.environment}, ${merged.accountId!}, ${merged.clientId!},
                  ${input.clientSecret ? encryptSecret(key, input.clientSecret) : before!.client_secret_enc},
                  ${input.refreshToken ? encryptSecret(key, input.refreshToken) : before!.refresh_token_enc},
                  ${input.signingKey ? encryptSecret(key, input.signingKey) : (before?.signing_key_enc ?? null)}, ${auth.adminId})
          ON CONFLICT (organization_id, provider) DO UPDATE SET
            enabled = EXCLUDED.enabled, environment = EXCLUDED.environment, account_id = EXCLUDED.account_id,
            client_id = EXCLUDED.client_id, client_secret_enc = EXCLUDED.client_secret_enc,
            refresh_token_enc = EXCLUDED.refresh_token_enc, signing_key_enc = EXCLUDED.signing_key_enc,
            updated_by = EXCLUDED.updated_by, updated_at = now(),
            last_test_at = CASE WHEN ${authChanged} THEN NULL ELSE organization_payment_gateways.last_test_at END,
            last_test_ok = CASE WHEN ${authChanged} THEN NULL ELSE organization_payment_gateways.last_test_ok END,
            last_test_message = CASE WHEN ${authChanged} THEN NULL ELSE organization_payment_gateways.last_test_message END`,
    );
    // The audit says what changed, never the values.
    await recordPlatformAudit(tx, {
      adminId: auth.adminId,
      action: before ? 'firm.zohopay_updated' : 'firm.zohopay_configured',
      organizationId,
      details: {
        environment: merged.environment,
        enabled,
        changed: (
          [
            'environment',
            'accountId',
            'clientId',
            'clientSecret',
            'refreshToken',
            'signingKey',
            'enabled',
          ] as const
        ).filter((k) => input[k] !== undefined),
      },
      ip: meta.ip,
    });
  });
  return getZohoPayConfig(deps, organizationId);
}

/** Signs in to Zoho with the stored credentials. Proves the client ID, secret and refresh token; it moves no money. */
export async function testZohoPayConfig(
  deps: Deps,
  auth: PlatformAuth,
  organizationId: string,
  meta: RequestMeta,
  fetchImpl: typeof fetch = fetch,
): Promise<ZohoPayConfigDto> {
  await assertFirm(deps.pool, organizationId);
  const cfg = await loadZohoPay(deps, deps.pool, organizationId);
  if (!cfg) throw conflict('Save the Zoho Pay details first');
  forgetAccessToken(cfg.credentials);
  let ok = true;
  let message = 'Signed in to Zoho Payments successfully.';
  try {
    await getAccessToken(cfg.credentials, fetchImpl);
  } catch (err) {
    ok = false;
    message = err instanceof ZohoPayError ? err.message : 'The connection test failed.';
  }
  if (ok && !cfg.signingKey) message += ' The webhook signing key is still missing.';
  await withTransaction(deps.pool, async (tx) => {
    await query(
      tx,
      sql`UPDATE organization_payment_gateways SET last_test_at = now(), last_test_ok = ${ok}, last_test_message = ${message.slice(0, 300)}
          WHERE organization_id = ${organizationId} AND provider = 'zohopay'`,
    );
    await recordPlatformAudit(tx, {
      adminId: auth.adminId,
      action: 'firm.zohopay_tested',
      organizationId,
      details: { ok },
      ip: meta.ip,
    });
  });
  return getZohoPayConfig(deps, organizationId);
}

/** Removes the stored credentials. Refused while customers still hold unpaid links that depend on them. */
export async function removeZohoPayConfig(
  deps: Deps,
  auth: PlatformAuth,
  organizationId: string,
  meta: RequestMeta,
): Promise<ZohoPayConfigDto> {
  await withTransaction(deps.pool, async (tx) => {
    await assertFirm(tx, organizationId);
    const open = await queryOne<{ n: number }>(
      tx,
      sql`SELECT count(*)::int AS n FROM payment_links WHERE organization_id = ${organizationId} AND provider = 'zohopay' AND status = 'active'`,
    );
    if (open && open.n > 0) {
      throw conflict(
        `${open.n} payment link${open.n === 1 ? ' is' : 's are'} still open. Turn online payments off instead, or wait until they are paid or expire.`,
      );
    }
    const gone = await query(
      tx,
      sql`DELETE FROM organization_payment_gateways WHERE organization_id = ${organizationId} AND provider = 'zohopay' RETURNING 1`,
    );
    if (gone.length)
      await recordPlatformAudit(tx, {
        adminId: auth.adminId,
        action: 'firm.zohopay_removed',
        organizationId,
        ip: meta.ip,
      });
  });
  return getZohoPayConfig(deps, organizationId);
}
