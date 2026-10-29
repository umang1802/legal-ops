import type {
  FeatureKey,
  OrganizationStatus,
  PlatformAuditEntry,
  PlatformFirmDetail,
  PlatformFirmFeature,
  PlatformFirmSummary,
  PlatformInvitationState,
  PlatformInviteLink,
  PlatformPendingInvitation,
} from '@legalops/types';
import { query, queryOne, withTransaction, type Db } from '../../db/pool.js';
import { sql } from '../../db/sql.js';
import type { Deps } from '../../deps.js';
import type { PlatformAuth, RequestMeta } from '../../http/context.js';
import { conflict, notFound } from '../../http/errors.js';
import { iso, likeContains, pageClause, type Page } from '../../http/query-helpers.js';
import { issueInvitationToken } from '../auth/auth.service.js';
import { listFirmFeatures, setFirmFeature, skipHeldEmails } from '../features/features.service.js';
import { emitEvent } from '../outbox/outbox.service.js';
import { recordPlatformAudit } from './platform-auth.service.js';

type FirmRow = {
  id: string; name: string; status: OrganizationStatus; created_at: Date; user_count: number; case_count: number;
  last_activity_at: Date | null; owner_email: string | null; owner_name: string | null; invite_email: string | null;
};

const FIRM_SELECT = sql`
  SELECT o.id, o.name, o.status, o.created_at,
    (SELECT count(*) FROM organization_members m WHERE m.organization_id = o.id AND m.status = 'active')::int AS user_count,
    (SELECT count(*) FROM cases c WHERE c.organization_id = o.id)::int AS case_count,
    (SELECT max(s.last_seen_at) FROM sessions s WHERE s.active_organization_id = o.id) AS last_activity_at,
    owner.email AS owner_email, owner.name AS owner_name, inv.email AS invite_email
  FROM organizations o
  LEFT JOIN LATERAL (
    SELECT u.email, trim(u.first_name || ' ' || COALESCE(u.last_name, '')) AS name
    FROM organization_members m JOIN users u ON u.id = m.user_id
    WHERE m.organization_id = o.id AND m.role = 'owner' AND m.status = 'active' ORDER BY m.joined_at LIMIT 1) owner ON TRUE
  LEFT JOIN LATERAL (
    SELECT i.email FROM invitations i
    WHERE i.organization_id = o.id AND i.role = 'owner' AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
    ORDER BY i.created_at DESC LIMIT 1) inv ON TRUE`;

const toSummary = (r: FirmRow): PlatformFirmSummary => ({
  id: r.id, name: r.name, status: r.status, ownerName: r.owner_name, ownerEmail: r.owner_email, inviteEmail: r.invite_email,
  userCount: r.user_count, caseCount: r.case_count, lastActivityAt: iso(r.last_activity_at), createdAt: r.created_at.toISOString(),
});

export async function listFirms(deps: Deps, f: Page & { search?: string | undefined; status?: OrganizationStatus | undefined }) {
  const where = sql`WHERE (${f.search ?? null}::text IS NULL OR o.name ILIKE ${f.search ? likeContains(f.search) : null})
                      AND (${f.status ?? null}::text IS NULL OR o.status = ${f.status ?? null})`;
  const rows = await query<FirmRow>(deps.pool, sql`${FIRM_SELECT} ${where} ORDER BY o.created_at DESC ${pageClause(f)}`);
  const total = await queryOne<{ n: number }>(deps.pool, sql`SELECT count(*)::int AS n FROM organizations o ${where}`);
  return { items: rows.map(toSummary), meta: { page: f.page, pageSize: f.pageSize, total: total!.n } };
}

export async function listPlatformAudit(db: Db, f: Page & { organizationId?: string | undefined }) {
  const where = sql`WHERE (${f.organizationId ?? null}::uuid IS NULL OR l.organization_id = ${f.organizationId ?? null})`;
  const rows = await query<{ id: string; action: string; admin_name: string; admin_email: string; organization_id: string | null; organization_name: string | null; details: Record<string, unknown>; created_at: Date }>(
    db,
    sql`SELECT l.id::text, l.action, a.name AS admin_name, a.email AS admin_email, l.organization_id, o.name AS organization_name, l.details, l.created_at
        FROM platform_audit_logs l JOIN platform_admins a ON a.id = l.platform_admin_id LEFT JOIN organizations o ON o.id = l.organization_id
        ${where} ORDER BY l.created_at DESC, l.id DESC ${pageClause(f)}`,
  );
  const total = await queryOne<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM platform_audit_logs l ${where}`);
  const items: PlatformAuditEntry[] = rows.map((r) => ({
    id: r.id, action: r.action, adminName: r.admin_name, adminEmail: r.admin_email, organizationId: r.organization_id,
    organizationName: r.organization_name, details: r.details, createdAt: r.created_at.toISOString(),
  }));
  return { items, meta: { page: f.page, pageSize: f.pageSize, total: total!.n } };
}

export async function getFirm(db: Db, id: string): Promise<PlatformFirmDetail> {
  const row = await queryOne<FirmRow & { platform_notes: string | null; suspended_at: Date | null; suspended_reason: string | null }>(
    db,
    sql`SELECT f.*, o2.platform_notes, o2.suspended_at, o2.suspended_reason FROM (${FIRM_SELECT} WHERE o.id = ${id}) f
        JOIN organizations o2 ON o2.id = f.id`,
  );
  if (!row) throw notFound('Firm');
  const inv = await queryOne<{ id: string; email: string; accepted_at: Date | null; revoked_at: Date | null; expires_at: Date; created_at: Date }>(
    db,
    sql`SELECT id, email, accepted_at, revoked_at, expires_at, created_at FROM invitations
        WHERE organization_id = ${id} AND role = 'owner' AND invited_by_platform_admin_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
  );
  const state: PlatformInvitationState | null = !inv ? null : inv.accepted_at ? 'accepted' : inv.revoked_at ? 'revoked' : inv.expires_at < new Date() ? 'expired' : 'pending';
  const history = await listPlatformAudit(db, { organizationId: id, page: 1, pageSize: 50 });
  return {
    ...toSummary(row),
    platformNotes: row.platform_notes,
    suspendedAt: iso(row.suspended_at),
    suspendedReason: row.suspended_reason,
    invitation: inv && state ? { id: inv.id, email: inv.email, state, expiresAt: inv.expires_at.toISOString(), createdAt: inv.created_at.toISOString() } : null,
    history: history.items,
  };
}

async function lockFirm(db: Db, id: string) {
  const org = await queryOne<{ id: string; status: OrganizationStatus }>(db, sql`SELECT id, status FROM organizations WHERE id = ${id} FOR UPDATE`);
  if (!org) throw notFound('Firm');
  return org;
}

export async function getFirmFeatures(db: Db, firmId: string): Promise<PlatformFirmFeature[]> {
  if (!(await queryOne(db, sql`SELECT 1 FROM organizations WHERE id = ${firmId}`))) throw notFound('Firm');
  return listFirmFeatures(db, firmId);
}

/** Switches one feature for a firm (allowed while it's suspended). Takes effect on the firm's next request. */
export async function setFirmFeatureAsAdmin(deps: Deps, auth: PlatformAuth, firmId: string, key: FeatureKey, enabled: boolean, meta: RequestMeta) {
  await withTransaction(deps.pool, async (tx) => {
    await lockFirm(tx, firmId);
    await setFirmFeature(tx, firmId, key, enabled, auth.adminId);
    if (!enabled) await skipHeldEmails(tx, firmId, key);
    const action = enabled ? 'firm.feature_enabled' : 'firm.feature_disabled';
    await recordPlatformAudit(tx, { adminId: auth.adminId, action, organizationId: firmId, details: { feature: key }, ip: meta.ip });
  });
  return listFirmFeatures(deps.pool, firmId);
}

/** Revokes any open owner invite, creates a new one and queues the set-up email (link minted at send time). */
async function issueOwnerInvite(db: Db, auth: PlatformAuth, orgId: string, partnerName: string, partnerEmail: string): Promise<string> {
  await query(db, sql`UPDATE invitations SET revoked_at = now() WHERE organization_id = ${orgId} AND accepted_at IS NULL AND revoked_at IS NULL`);
  const inv = await queryOne<{ id: string }>(
    db,
    sql`INSERT INTO invitations (organization_id, email, role, invited_by_platform_admin_id, expires_at)
        VALUES (${orgId}, ${partnerEmail}, 'owner', ${auth.adminId}, now() + interval '7 days') RETURNING id`,
  );
  await emitEvent(db, {
    organizationId: orgId, eventType: 'MEMBER_INVITED', aggregateType: 'invitation', aggregateId: inv!.id,
    payload: { invitationId: inv!.id, email: partnerEmail, role: 'owner', platformInvite: true, partnerName }, actorUserId: null,
  });
  return inv!.id;
}

export async function inviteFirm(deps: Deps, auth: PlatformAuth, input: { firmName: string; partnerName: string; partnerEmail: string }, meta: RequestMeta) {
  const id = await withTransaction(deps.pool, async (tx) => {
    const org = await queryOne<{ id: string }>(tx, sql`INSERT INTO organizations (name, status) VALUES (${input.firmName}, 'invited') RETURNING id`);
    await issueOwnerInvite(tx, auth, org!.id, input.partnerName, input.partnerEmail);
    await recordPlatformAudit(tx, { adminId: auth.adminId, action: 'firm.invited', organizationId: org!.id, details: { partnerEmail: input.partnerEmail }, ip: meta.ip });
    return org!.id;
  });
  return getFirm(deps.pool, id);
}

export async function updateNotes(deps: Deps, auth: PlatformAuth, id: string, platformNotes: string | null, meta: RequestMeta) {
  await withTransaction(deps.pool, async (tx) => {
    await lockFirm(tx, id);
    await query(tx, sql`UPDATE organizations SET platform_notes = ${platformNotes} WHERE id = ${id}`);
    // Notes can hold payment details; the audit records that they changed, not what they say.
    await recordPlatformAudit(tx, { adminId: auth.adminId, action: 'firm.notes_updated', organizationId: id, details: { length: platformNotes?.length ?? 0 }, ip: meta.ip });
  });
  return getFirm(deps.pool, id);
}

export async function suspendFirm(deps: Deps, auth: PlatformAuth, id: string, reason: string, meta: RequestMeta) {
  await withTransaction(deps.pool, async (tx) => {
    const org = await lockFirm(tx, id);
    if (org.status !== 'active') throw conflict(`Only an active firm can be suspended (this one is ${org.status})`);
    await query(tx, sql`UPDATE organizations SET status = 'suspended', suspended_at = now(), suspended_reason = ${reason} WHERE id = ${id}`);
    await recordPlatformAudit(tx, { adminId: auth.adminId, action: 'firm.suspended', organizationId: id, details: { reason }, ip: meta.ip });
  });
  return getFirm(deps.pool, id);
}

export async function reactivateFirm(deps: Deps, auth: PlatformAuth, id: string, meta: RequestMeta) {
  await withTransaction(deps.pool, async (tx) => {
    const org = await lockFirm(tx, id);
    if (org.status !== 'suspended') throw conflict(`Only a suspended firm can be reactivated (this one is ${org.status})`);
    await query(tx, sql`UPDATE organizations SET status = 'active', suspended_at = NULL, suspended_reason = NULL WHERE id = ${id}`);
    // Anything that fell due while suspended and wasn't yet claimed (worker down or behind) is stale: skip it, never send late.
    await query(
      tx,
      sql`UPDATE scheduled_actions SET status = 'skipped', executed_at = now(), result = ${JSON.stringify({ reason: 'Firm suspended' })}
          WHERE organization_id = ${id} AND status IN ('scheduled', 'queued') AND run_at <= now()`,
    );
    await recordPlatformAudit(tx, { adminId: auth.adminId, action: 'firm.reactivated', organizationId: id, ip: meta.ip });
  });
  return getFirm(deps.pool, id);
}

async function openOwnerInvite(db: Db, orgId: string) {
  return queryOne<{ id: string; email: string }>(
    db,
    sql`SELECT id, email FROM invitations WHERE organization_id = ${orgId} AND role = 'owner' AND accepted_at IS NULL AND revoked_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
  );
}

export async function resendInvite(deps: Deps, auth: PlatformAuth, id: string, meta: RequestMeta) {
  await withTransaction(deps.pool, async (tx) => {
    const org = await lockFirm(tx, id);
    if (org.status !== 'invited') throw conflict('This firm has already been set up');
    const inv = await openOwnerInvite(tx, id);
    if (!inv) throw conflict('There is no open invitation; send a new one');
    // A new MEMBER_INVITED event sends a fresh email; minting its link replaces the old token and resets expiry.
    await query(tx, sql`UPDATE invitations SET expires_at = now() + interval '7 days' WHERE id = ${inv.id}`);
    const prior = await queryOne<{ name: string | null }>(
      tx,
      sql`SELECT payload->>'partnerName' AS name FROM outbox_events
          WHERE event_type = 'MEMBER_INVITED' AND payload->>'invitationId' = ${inv.id} ORDER BY created_at LIMIT 1`,
    );
    await emitEvent(tx, {
      organizationId: id, eventType: 'MEMBER_INVITED', aggregateType: 'invitation', aggregateId: inv.id,
      payload: { invitationId: inv.id, email: inv.email, role: 'owner', platformInvite: true, partnerName: prior?.name ?? '' }, actorUserId: null,
    });
    await recordPlatformAudit(tx, { adminId: auth.adminId, action: 'firm.invite_resent', organizationId: id, details: { partnerEmail: inv.email }, ip: meta.ip });
  });
  return getFirm(deps.pool, id);
}

export async function revokeInvite(deps: Deps, auth: PlatformAuth, id: string, meta: RequestMeta) {
  await withTransaction(deps.pool, async (tx) => {
    const org = await lockFirm(tx, id);
    if (org.status !== 'invited') throw conflict('This firm has already been set up');
    const inv = await openOwnerInvite(tx, id);
    if (!inv) throw conflict('There is no open invitation');
    await query(tx, sql`UPDATE invitations SET revoked_at = now() WHERE id = ${inv.id}`);
    await recordPlatformAudit(tx, { adminId: auth.adminId, action: 'firm.invite_revoked', organizationId: id, details: { partnerEmail: inv.email }, ip: meta.ip });
  });
  return getFirm(deps.pool, id);
}

export async function reinviteFirm(deps: Deps, auth: PlatformAuth, id: string, input: { partnerName: string; partnerEmail: string }, meta: RequestMeta) {
  await withTransaction(deps.pool, async (tx) => {
    const org = await lockFirm(tx, id);
    if (org.status !== 'invited') throw conflict('This firm has already been set up');
    await issueOwnerInvite(tx, auth, id, input.partnerName, input.partnerEmail);
    await recordPlatformAudit(tx, { adminId: auth.adminId, action: 'firm.reinvited', organizationId: id, details: { partnerEmail: input.partnerEmail }, ip: meta.ip });
  });
  return getFirm(deps.pool, id);
}

/** Open invitations for a firm (owner and team), newest first. */
export async function listPendingInvitations(db: Db, firmId: string): Promise<PlatformPendingInvitation[]> {
  const firm = await queryOne<{ id: string }>(db, sql`SELECT id FROM organizations WHERE id = ${firmId}`);
  if (!firm) throw notFound('Firm');
  const rows = await query<{ id: string; email: string; role: string; inviter: string | null; from_platform: boolean; expires_at: Date; created_at: Date }>(
    db,
    sql`SELECT i.id, i.email, i.role, trim(u.first_name || ' ' || COALESCE(u.last_name, '')) AS inviter,
               (i.invited_by_platform_admin_id IS NOT NULL) AS from_platform, i.expires_at, i.created_at
        FROM invitations i LEFT JOIN users u ON u.id = i.invited_by
        WHERE i.organization_id = ${firmId} AND i.accepted_at IS NULL AND i.revoked_at IS NULL
        ORDER BY i.created_at DESC`,
  );
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    invitedBy: r.from_platform ? 'LexForgeX team' : (r.inviter ?? ''),
    expiresAt: r.expires_at.toISOString(),
    expired: r.expires_at < new Date(),
    createdAt: r.created_at.toISOString(),
  }));
}

/**
 * Mints a new accept-invite link for an open invitation so the team can share it without email (for example over
 * WhatsApp). Minting replaces the stored token (the previous link stops working) and resets the 7-day expiry.
 * The token is never stored or logged; the audit entry records who issued a link for whom.
 */
export async function issueInviteLink(
  deps: Deps,
  auth: PlatformAuth,
  firmId: string,
  invitationId: string,
  meta: RequestMeta,
): Promise<PlatformInviteLink> {
  const inv = await queryOne<{ email: string; role: string; accepted: boolean; revoked: boolean; firm_status: OrganizationStatus }>(
    deps.pool,
    sql`SELECT i.email, i.role, (i.accepted_at IS NOT NULL) AS accepted, (i.revoked_at IS NOT NULL) AS revoked, o.status AS firm_status
        FROM invitations i JOIN organizations o ON o.id = i.organization_id
        WHERE i.id = ${invitationId} AND i.organization_id = ${firmId}`,
  );
  if (!inv) throw notFound('Invitation');
  if (inv.accepted) throw conflict('This invitation has already been accepted');
  if (inv.revoked) throw conflict('This invitation was revoked; send a new one');
  if (inv.firm_status === 'suspended') throw conflict('This firm is suspended; reactivate it before inviting anyone');
  const token = await issueInvitationToken(deps, invitationId);
  const row = await queryOne<{ expires_at: Date }>(deps.pool, sql`SELECT expires_at FROM invitations WHERE id = ${invitationId}`);
  await recordPlatformAudit(deps.pool, {
    adminId: auth.adminId,
    action: 'invite.link_issued',
    organizationId: firmId,
    details: { invitationId, email: inv.email, role: inv.role },
    ip: meta.ip,
  });
  return {
    url: `${deps.env.APP_URL.replace(/\/$/, '')}/accept-invite?token=${token}`,
    email: inv.email,
    role: inv.role,
    expiresAt: row!.expires_at.toISOString(),
  };
}
