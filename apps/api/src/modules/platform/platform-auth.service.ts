import { randomBytes } from 'node:crypto';
import type { PlatformMe } from '@legalops/types';
import { query, queryOne, type Db } from '../../db/pool.js';
import { sql } from '../../db/sql.js';
import type { Deps } from '../../deps.js';
import type { PlatformAuth, RequestMeta } from '../../http/context.js';
import { AppError, conflict, unauthenticated } from '../../http/errors.js';
import { hashPassword, hashToken, randomToken, verifyPassword } from '../auth/crypto.js';
import { decryptSecret, encryptSecret, platformKey } from './secrets.js';
import { generateTotpSecret, otpauthUrl, verifyTotp } from './totp.js';

const IDLE_MINUTES = 30;
const ABSOLUTE_HOURS = 12;
/** A session that hasn't passed the second factor lives this long (time to scan a key and type a code). */
const PASSWORD_ONLY_MINUTES = 10;
const MAX_TOTP_FAILURES = 5;
const TOTP_LOCK_MINUTES = 15;

const invalidCredentials = () => new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');

export async function recordPlatformAudit(
  db: Db,
  e: { adminId: string; action: string; organizationId?: string | null; details?: Record<string, unknown>; ip?: string | null },
): Promise<void> {
  await query(
    db,
    sql`INSERT INTO platform_audit_logs (platform_admin_id, action, organization_id, details, ip_address)
        VALUES (${e.adminId}, ${e.action}, ${e.organizationId ?? null}, ${JSON.stringify(e.details ?? {})}, ${e.ip ?? null})`,
  );
}

/** CLI only. Creates an admin, or with reset issues a new password and clears TOTP. Returns the one-time password. */
export async function createOrResetAdmin(db: Db, input: { email: string; name: string; reset: boolean }): Promise<{ password: string; created: boolean }> {
  const password = randomBytes(18).toString('base64url'); // 24 chars
  const passwordHash = await hashPassword(password);
  const existing = await queryOne<{ id: string }>(db, sql`SELECT id FROM platform_admins WHERE email = ${input.email}`);
  if (existing && !input.reset) throw new Error(`Platform admin ${input.email} already exists (use --reset)`);
  if (existing) {
    await query(
      db,
      sql`UPDATE platform_admins SET password_hash = ${passwordHash}, name = ${input.name}, totp_secret_enc = NULL,
            totp_enrolled_at = NULL, totp_last_step = NULL, failed_totp_attempts = 0, totp_locked_until = NULL, is_active = true
        WHERE id = ${existing.id}`,
    );
    await query(db, sql`UPDATE platform_sessions SET revoked_at = now() WHERE platform_admin_id = ${existing.id} AND revoked_at IS NULL`);
    return { password, created: false };
  }
  await query(db, sql`INSERT INTO platform_admins (email, name, password_hash) VALUES (${input.email}, ${input.name}, ${passwordHash})`);
  return { password, created: true };
}

export async function platformLogin(deps: Deps, input: { email: string; password: string }, meta: RequestMeta): Promise<{ token: string; expiresAt: Date; me: PlatformMe }> {
  const admin = await queryOne<{ id: string; password_hash: string; is_active: boolean }>(
    deps.pool,
    sql`SELECT id, password_hash, is_active FROM platform_admins WHERE email = ${input.email}`,
  );
  const ok = await verifyPassword(admin?.password_hash, input.password);
  if (admin && !ok) await recordPlatformAudit(deps.pool, { adminId: admin.id, action: 'admin.login_failed', ip: meta.ip });
  if (!admin || !ok || !admin.is_active) throw invalidCredentials();
  const token = randomToken();
  const expiresAt = new Date(Date.now() + ABSOLUTE_HOURS * 3600_000);
  const id = hashToken(deps.env.SESSION_SECRET, token);
  await query(
    deps.pool,
    sql`INSERT INTO platform_sessions (id, platform_admin_id, csrf_secret, ip_address, user_agent, expires_at)
        VALUES (${id}, ${admin.id}, ${randomToken()}, ${meta.ip}, ${meta.userAgent}, ${expiresAt})`,
  );
  return { token, expiresAt, me: await getPlatformMe(deps, id) };
}

/** Resolves the cookie; enforces revocation, absolute expiry, 30-minute idle timeout and an active admin. */
export async function loadPlatformSession(deps: Deps, token: string): Promise<PlatformAuth | null> {
  const id = hashToken(deps.env.SESSION_SECRET, token);
  const row = await queryOne<{ admin_id: string; csrf_secret: string; mfa: boolean }>(
    deps.pool,
    sql`UPDATE platform_sessions s SET last_seen_at = now()
        FROM platform_admins a
        WHERE s.id = ${id} AND a.id = s.platform_admin_id AND a.is_active
          AND s.revoked_at IS NULL AND s.expires_at > now()
          AND s.last_seen_at > now() - ${`${IDLE_MINUTES} minutes`}::interval
          AND (s.mfa_verified_at IS NOT NULL OR s.created_at > now() - ${`${PASSWORD_ONLY_MINUTES} minutes`}::interval)
        RETURNING s.platform_admin_id AS admin_id, s.csrf_secret, (s.mfa_verified_at IS NOT NULL) AS mfa`,
  );
  return row ? { sessionId: id, adminId: row.admin_id, csrfSecret: row.csrf_secret, mfaVerified: row.mfa } : null;
}

export async function getPlatformMe(deps: Deps, sessionId: string): Promise<PlatformMe> {
  const row = await queryOne<{ id: string; email: string; name: string; enrolled: boolean; verified: boolean; csrf_secret: string }>(
    deps.pool,
    sql`SELECT a.id, a.email, a.name, (a.totp_enrolled_at IS NOT NULL) AS enrolled, (s.mfa_verified_at IS NOT NULL) AS verified, s.csrf_secret
        FROM platform_sessions s JOIN platform_admins a ON a.id = s.platform_admin_id WHERE s.id = ${sessionId}`,
  );
  if (!row) throw unauthenticated();
  return { admin: { id: row.id, email: row.email, name: row.name }, mfaEnrolled: row.enrolled, mfaVerified: row.verified, csrfToken: row.csrf_secret };
}

export async function startTotpEnrolment(deps: Deps, auth: PlatformAuth): Promise<{ secret: string; otpauthUrl: string }> {
  const admin = await queryOne<{ email: string; enrolled: boolean }>(
    deps.pool,
    sql`SELECT email, (totp_enrolled_at IS NOT NULL) AS enrolled FROM platform_admins WHERE id = ${auth.adminId}`,
  );
  if (!admin) throw unauthenticated();
  if (admin.enrolled) throw conflict('Two-factor sign-in is already set up. Ask another admin to reset it with the CLI.');
  const secret = generateTotpSecret();
  await query(deps.pool, sql`UPDATE platform_admins SET totp_secret_enc = ${encryptSecret(platformKey(deps.env), secret)} WHERE id = ${auth.adminId}`);
  return { secret, otpauthUrl: otpauthUrl(secret, admin.email) };
}

export async function confirmTotp(deps: Deps, auth: PlatformAuth, code: string, meta: RequestMeta): Promise<PlatformMe> {
  const admin = await queryOne<{ secret: string | null; last_step: string | null; enrolled: boolean; locked: boolean }>(
    deps.pool,
    sql`SELECT totp_secret_enc AS secret, totp_last_step::text AS last_step, (totp_enrolled_at IS NOT NULL) AS enrolled,
               COALESCE(totp_locked_until > now(), false) AS locked
        FROM platform_admins WHERE id = ${auth.adminId}`,
  );
  if (!admin?.secret) throw new AppError(409, 'CONFLICT', 'Set up two-factor sign-in first');
  if (admin.locked) throw tooManyCodes();
  const step = verifyTotp(decryptSecret(platformKey(deps.env), admin.secret), code, Date.now(), admin.last_step === null ? null : Number(admin.last_step));
  if (step === null) {
    await recordTotpFailure(deps, auth, meta);
    throw new AppError(401, 'INVALID_CREDENTIALS', 'That code didn’t work. Check your authenticator and try again.');
  }
  // The guarded UPDATE closes the race between two sessions submitting the same code.
  const updated = await query(
    deps.pool,
    sql`UPDATE platform_admins SET totp_last_step = ${step}, totp_enrolled_at = COALESCE(totp_enrolled_at, now()), last_login_at = now(),
               failed_totp_attempts = 0
        WHERE id = ${auth.adminId} AND (totp_last_step IS NULL OR totp_last_step < ${step}) RETURNING id`,
  );
  if (!updated.length) throw new AppError(401, 'INVALID_CREDENTIALS', 'That code was already used. Wait for the next one.');
  await query(deps.pool, sql`UPDATE platform_sessions SET mfa_verified_at = now() WHERE id = ${auth.sessionId}`);
  await recordPlatformAudit(deps.pool, { adminId: auth.adminId, action: admin.enrolled ? 'admin.signed_in' : 'admin.mfa_enrolled', ip: meta.ip });
  return getPlatformMe(deps, auth.sessionId);
}

const tooManyCodes = () => new AppError(429, 'RATE_LIMITED', `Too many wrong codes. Try again in ${TOTP_LOCK_MINUTES} minutes.`);

/**
 * Per-admin throttle (RFC 6238 §5.2), independent of IP: after MAX_TOTP_FAILURES wrong codes the
 * second factor locks for TOTP_LOCK_MINUTES and every password-only session for that admin ends.
 */
async function recordTotpFailure(deps: Deps, auth: PlatformAuth, meta: RequestMeta): Promise<void> {
  const row = await queryOne<{ attempts: number }>(
    deps.pool,
    sql`UPDATE platform_admins SET failed_totp_attempts = failed_totp_attempts + 1 WHERE id = ${auth.adminId}
        RETURNING failed_totp_attempts AS attempts`,
  );
  await recordPlatformAudit(deps.pool, { adminId: auth.adminId, action: 'admin.mfa_failed', ip: meta.ip });
  if ((row?.attempts ?? 0) < MAX_TOTP_FAILURES) return;
  await query(
    deps.pool,
    sql`UPDATE platform_admins SET failed_totp_attempts = 0, totp_locked_until = now() + ${`${TOTP_LOCK_MINUTES} minutes`}::interval
        WHERE id = ${auth.adminId}`,
  );
  await query(
    deps.pool,
    sql`UPDATE platform_sessions SET revoked_at = now()
        WHERE platform_admin_id = ${auth.adminId} AND mfa_verified_at IS NULL AND revoked_at IS NULL`,
  );
  await recordPlatformAudit(deps.pool, { adminId: auth.adminId, action: 'admin.mfa_locked', ip: meta.ip });
  throw tooManyCodes();
}

export async function platformLogout(deps: Deps, auth: PlatformAuth): Promise<void> {
  await query(deps.pool, sql`UPDATE platform_sessions SET revoked_at = now() WHERE id = ${auth.sessionId}`);
}
