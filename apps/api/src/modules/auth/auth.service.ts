import { isRole, permissionsFor, type MeResponse, type Role } from '@legalops/types';
import { query, queryOne, withTransaction, type Db } from '../../db/pool.js';
import { sql } from '../../db/sql.js';
import type { Deps } from '../../deps.js';
import type { AuthContext, RequestMeta } from '../../http/context.js';
import { AppError, forbidden, unauthenticated } from '../../http/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { emitEvent } from '../outbox/outbox.service.js';
import { hashPassword, hashToken, randomToken, verifyPassword } from './crypto.js';

const RESET_TTL_MINUTES = 60;
const VERIFY_TTL_HOURS = 48;
const INVITE_TTL_DAYS = 7;
const TOUCH_INTERVAL = '5 minutes';

export type IssuedSession = { token: string; expiresAt: Date; me: MeResponse };

const invalidLink = () => new AppError(400, 'TOKEN_INVALID', 'This link is invalid or has expired');

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

async function createSession(
  deps: Deps,
  db: Db,
  args: { userId: string; organizationId: string; remember: boolean; meta: RequestMeta },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken();
  const hours = args.remember ? deps.env.SESSION_REMEMBER_DAYS * 24 : deps.env.SESSION_TTL_HOURS;
  const expiresAt = new Date(Date.now() + hours * 3600_000);
  await query(
    db,
    sql`INSERT INTO sessions (id, user_id, active_organization_id, csrf_secret, ip_address, user_agent, expires_at)
        VALUES (${hashToken(deps.env.SESSION_SECRET, token)}, ${args.userId}, ${args.organizationId},
                ${randomToken()}, ${args.meta.ip}, ${args.meta.userAgent}, ${expiresAt})`,
  );
  return { token, expiresAt };
}

/** Resolves a cookie token to an auth context. Re-checks user + membership on every request. */
export async function loadSession(deps: Deps, token: string): Promise<AuthContext | null> {
  const id = hashToken(deps.env.SESSION_SECRET, token);
  const row = await queryOne<{ user_id: string; organization_id: string; role: string; csrf_secret: string }>(
    deps.pool,
    sql`SELECT s.user_id, s.active_organization_id AS organization_id, m.role, s.csrf_secret
        FROM sessions s
        JOIN users u ON u.id = s.user_id AND u.is_active
        JOIN organization_members m
          ON m.user_id = s.user_id AND m.organization_id = s.active_organization_id AND m.status = 'active'
        WHERE s.id = ${id} AND s.revoked_at IS NULL AND s.expires_at > now()`,
  );
  if (!row || !isRole(row.role)) return null;
  await query(
    deps.pool,
    sql`UPDATE sessions SET last_seen_at = now()
        WHERE id = ${id} AND last_seen_at < now() - ${TOUCH_INTERVAL}::interval`,
  );
  return {
    sessionId: id,
    userId: row.user_id,
    organizationId: row.organization_id,
    role: row.role,
    csrfSecret: row.csrf_secret,
  };
}

// ---------------------------------------------------------------------------
// Me
// ---------------------------------------------------------------------------

export async function getMe(deps: Deps, db: Db, sessionId: string): Promise<MeResponse> {
  const row = await queryOne<{
    user_id: string;
    email: string;
    first_name: string;
    last_name: string | null;
    email_verified_at: Date | null;
    org_id: string;
    org_name: string;
    timezone: string;
    currency: string;
    tax_mode: 'simple' | 'gst';
    role: Role;
    csrf_secret: string;
  }>(
    db,
    sql`SELECT u.id AS user_id, u.email, u.first_name, u.last_name, u.email_verified_at,
               o.id AS org_id, o.name AS org_name, o.timezone, o.currency, o.tax_mode, m.role, s.csrf_secret
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        JOIN organizations o ON o.id = s.active_organization_id
        JOIN organization_members m ON m.user_id = u.id AND m.organization_id = o.id AND m.status = 'active'
        WHERE s.id = ${sessionId}`,
  );
  if (!row) throw unauthenticated();
  const memberships = await query<{ organization_id: string; name: string; role: Role }>(
    db,
    sql`SELECT m.organization_id, o.name, m.role
        FROM organization_members m JOIN organizations o ON o.id = m.organization_id
        WHERE m.user_id = ${row.user_id} AND m.status = 'active'
        ORDER BY o.name`,
  );
  return {
    user: {
      id: row.user_id,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      emailVerified: row.email_verified_at !== null,
    },
    organization: {
      id: row.org_id,
      name: row.org_name,
      timezone: row.timezone,
      currency: row.currency,
      taxMode: row.tax_mode,
    },
    role: row.role,
    permissions: permissionsFor(row.role),
    memberships: memberships.map((m) => ({
      organizationId: m.organization_id,
      organizationName: m.name,
      role: m.role,
    })),
    csrfToken: row.csrf_secret,
  };
}

// ---------------------------------------------------------------------------
// Login / logout / switch org
// ---------------------------------------------------------------------------

export async function login(
  deps: Deps,
  input: { email: string; password: string; remember: boolean },
  meta: RequestMeta,
): Promise<IssuedSession> {
  const user = await queryOne<{ id: string; password_hash: string | null; is_active: boolean }>(
    deps.pool,
    sql`SELECT id, password_hash, is_active FROM users WHERE email = ${input.email}`,
  );
  const ok = await verifyPassword(user?.password_hash, input.password);
  if (!user || !ok) {
    await recordAudit(deps.pool, {
      organizationId: null,
      actorUserId: user?.id ?? null,
      action: 'auth.login_failed',
      entityType: 'user',
      entityId: user?.id ?? null,
      after: { email: input.email },
      meta,
    });
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password');
  }
  // Only revealed after a correct password, so it can't be used to enumerate accounts.
  if (!user.is_active) throw new AppError(403, 'ACCOUNT_DISABLED', 'This account has been disabled');

  const membership = await queryOne<{ organization_id: string }>(
    deps.pool,
    sql`SELECT m.organization_id FROM organization_members m
        WHERE m.user_id = ${user.id} AND m.status = 'active'
        ORDER BY (SELECT max(s.last_seen_at) FROM sessions s
                  WHERE s.user_id = m.user_id AND s.active_organization_id = m.organization_id) DESC NULLS LAST,
                 m.joined_at NULLS LAST
        LIMIT 1`,
  );
  if (!membership) throw new AppError(403, 'NO_MEMBERSHIP', 'Your account is not active in any firm');

  return withTransaction(deps.pool, async (tx) => {
    const session = await createSession(deps, tx, {
      userId: user.id,
      organizationId: membership.organization_id,
      remember: input.remember,
      meta,
    });
    await query(tx, sql`UPDATE users SET last_login_at = now() WHERE id = ${user.id}`);
    await recordAudit(tx, {
      organizationId: membership.organization_id,
      actorUserId: user.id,
      action: 'auth.login',
      entityType: 'user',
      entityId: user.id,
      meta,
    });
    const me = await getMe(deps, tx, hashToken(deps.env.SESSION_SECRET, session.token));
    return { ...session, me };
  });
}

export async function logout(deps: Deps, auth: AuthContext, meta: RequestMeta): Promise<void> {
  await withTransaction(deps.pool, async (tx) => {
    await query(
      tx,
      sql`UPDATE sessions SET revoked_at = now() WHERE id = ${auth.sessionId} AND revoked_at IS NULL`,
    );
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      actorUserId: auth.userId,
      action: 'auth.logout',
      entityType: 'user',
      entityId: auth.userId,
      meta,
    });
  });
}

export async function switchOrganization(
  deps: Deps,
  auth: AuthContext,
  organizationId: string,
  meta: RequestMeta,
): Promise<MeResponse> {
  return withTransaction(deps.pool, async (tx) => {
    const member = await queryOne<{ id: string }>(
      tx,
      sql`SELECT id FROM organization_members
          WHERE user_id = ${auth.userId} AND organization_id = ${organizationId} AND status = 'active'`,
    );
    if (!member) throw forbidden('You are not a member of that firm');
    await query(
      tx,
      sql`UPDATE sessions SET active_organization_id = ${organizationId} WHERE id = ${auth.sessionId}`,
    );
    await recordAudit(tx, {
      organizationId,
      actorUserId: auth.userId,
      action: 'auth.switch_organization',
      entityType: 'organization',
      entityId: organizationId,
      before: { organizationId: auth.organizationId },
      meta,
    });
    return getMe(deps, tx, auth.sessionId);
  });
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

/** Always succeeds from the caller's view so it never reveals whether an email is registered. */
export async function requestPasswordReset(deps: Deps, email: string, meta: RequestMeta): Promise<void> {
  const user = await queryOne<{ id: string; organization_id: string | null }>(
    deps.pool,
    sql`SELECT u.id,
               (SELECT m.organization_id FROM organization_members m
                 WHERE m.user_id = u.id AND m.status = 'active' ORDER BY m.joined_at NULLS LAST LIMIT 1) AS organization_id
        FROM users u WHERE u.email = ${email} AND u.is_active`,
  );
  if (!user?.organization_id) return;
  await withTransaction(deps.pool, async (tx) => {
    // The worker generates the token at send time; no secret ever lands in the outbox.
    await emitEvent(tx, {
      organizationId: user.organization_id!,
      eventType: 'PASSWORD_RESET_REQUESTED',
      aggregateType: 'user',
      aggregateId: user.id,
      payload: { userId: user.id },
    });
    await recordAudit(tx, {
      organizationId: user.organization_id,
      actorUserId: user.id,
      action: 'auth.password_reset_requested',
      entityType: 'user',
      entityId: user.id,
      meta,
    });
  });
}

async function issueUserToken(
  deps: Deps,
  userId: string,
  type: 'password_reset' | 'email_verification',
  ttl: string,
): Promise<string> {
  const token = randomToken();
  await withTransaction(deps.pool, async (tx) => {
    // Only the newest link works.
    await query(
      tx,
      sql`UPDATE auth_tokens SET used_at = now()
          WHERE user_id = ${userId} AND token_type = ${type} AND used_at IS NULL`,
    );
    await query(
      tx,
      sql`INSERT INTO auth_tokens (user_id, token_type, token_hash, expires_at)
          VALUES (${userId}, ${type}, ${hashToken(deps.env.SESSION_SECRET, token)}, now() + ${ttl}::interval)`,
    );
  });
  return token;
}

/** Called by the email worker when it sends the reset email. Returns the raw token for the link. */
export function issuePasswordResetToken(deps: Deps, userId: string): Promise<string> {
  return issueUserToken(deps, userId, 'password_reset', `${RESET_TTL_MINUTES} minutes`);
}

export function issueEmailVerificationToken(deps: Deps, userId: string): Promise<string> {
  return issueUserToken(deps, userId, 'email_verification', `${VERIFY_TTL_HOURS} hours`);
}

async function consumeUserToken(
  db: Db,
  deps: Deps,
  token: string,
  type: 'password_reset' | 'email_verification',
): Promise<string> {
  const row = await queryOne<{ id: string; user_id: string }>(
    db,
    sql`SELECT t.id, t.user_id FROM auth_tokens t JOIN users u ON u.id = t.user_id AND u.is_active
        WHERE t.token_hash = ${hashToken(deps.env.SESSION_SECRET, token)} AND t.token_type = ${type}
          AND t.used_at IS NULL AND t.expires_at > now()
        FOR UPDATE OF t`,
  );
  if (!row) throw invalidLink();
  await query(db, sql`UPDATE auth_tokens SET used_at = now() WHERE id = ${row.id}`);
  return row.user_id;
}

export async function resetPassword(
  deps: Deps,
  input: { token: string; password: string },
  meta: RequestMeta,
): Promise<void> {
  const passwordHash = await hashPassword(input.password);
  await withTransaction(deps.pool, async (tx) => {
    const userId = await consumeUserToken(tx, deps, input.token, 'password_reset');
    // Resetting via the emailed link proves inbox control, so it also verifies the email.
    await query(
      tx,
      sql`UPDATE users SET password_hash = ${passwordHash}, email_verified_at = COALESCE(email_verified_at, now())
          WHERE id = ${userId}`,
    );
    await query(
      tx,
      sql`UPDATE sessions SET revoked_at = now() WHERE user_id = ${userId} AND revoked_at IS NULL`,
    );
    await recordAudit(tx, {
      organizationId: null,
      actorUserId: userId,
      action: 'auth.password_reset',
      entityType: 'user',
      entityId: userId,
      meta,
    });
  });
}

export async function verifyEmail(deps: Deps, token: string, meta: RequestMeta): Promise<void> {
  await withTransaction(deps.pool, async (tx) => {
    const userId = await consumeUserToken(tx, deps, token, 'email_verification');
    await query(
      tx,
      sql`UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = ${userId}`,
    );
    await recordAudit(tx, {
      organizationId: null,
      actorUserId: userId,
      action: 'auth.email_verified',
      entityType: 'user',
      entityId: userId,
      meta,
    });
  });
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

/** Called by the email worker when it sends the invite. Rotates the token so only the latest email works. */
export async function issueInvitationToken(deps: Deps, invitationId: string): Promise<string> {
  const token = randomToken();
  const row = await queryOne<{ id: string }>(
    deps.pool,
    sql`UPDATE invitations
        SET token_hash = ${hashToken(deps.env.SESSION_SECRET, token)}, expires_at = now() + ${`${INVITE_TTL_DAYS} days`}::interval
        WHERE id = ${invitationId} AND accepted_at IS NULL AND revoked_at IS NULL
        RETURNING id`,
  );
  if (!row) throw invalidLink();
  return token;
}

export async function acceptInvitation(
  deps: Deps,
  input: { token: string; firstName: string; lastName?: string | undefined; password: string },
  meta: RequestMeta,
): Promise<{ existingAccount: boolean }> {
  const passwordHash = await hashPassword(input.password);
  return withTransaction(deps.pool, async (tx) => {
    const invite = await queryOne<{ id: string; organization_id: string; email: string; role: Role }>(
      tx,
      sql`SELECT id, organization_id, email, role FROM invitations
          WHERE token_hash = ${hashToken(deps.env.SESSION_SECRET, input.token)}
            AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
          FOR UPDATE`,
    );
    if (!invite) throw invalidLink();

    const existing = await queryOne<{ id: string; password_hash: string | null; is_active: boolean }>(
      tx,
      sql`SELECT id, password_hash, is_active FROM users WHERE email = ${invite.email} FOR UPDATE`,
    );
    if (existing && !existing.is_active)
      throw new AppError(403, 'ACCOUNT_DISABLED', 'This account has been disabled');

    let userId: string;
    if (existing?.password_hash) {
      // Existing account joins another firm; its password is not touched.
      userId = existing.id;
    } else if (existing) {
      userId = existing.id;
      await query(
        tx,
        sql`UPDATE users SET password_hash = ${passwordHash}, first_name = ${input.firstName},
                             last_name = ${input.lastName ?? null}, email_verified_at = COALESCE(email_verified_at, now())
            WHERE id = ${userId}`,
      );
    } else {
      const created = await queryOne<{ id: string }>(
        tx,
        sql`INSERT INTO users (email, password_hash, first_name, last_name, email_verified_at)
            VALUES (${invite.email}, ${passwordHash}, ${input.firstName}, ${input.lastName ?? null}, now())
            RETURNING id`,
      );
      userId = created!.id;
    }

    await query(
      tx,
      sql`INSERT INTO organization_members (organization_id, user_id, role, status, joined_at)
          VALUES (${invite.organization_id}, ${userId}, ${invite.role}, 'active', now())
          ON CONFLICT (organization_id, user_id)
          DO UPDATE SET role = EXCLUDED.role, status = 'active', joined_at = now()`,
    );
    await query(tx, sql`UPDATE invitations SET accepted_at = now() WHERE id = ${invite.id}`);
    await recordAudit(tx, {
      organizationId: invite.organization_id,
      actorUserId: userId,
      action: 'member.invitation_accepted',
      entityType: 'invitation',
      entityId: invite.id,
      after: { role: invite.role, email: invite.email },
      meta,
    });
    return { existingAccount: Boolean(existing?.password_hash) };
  });
}
