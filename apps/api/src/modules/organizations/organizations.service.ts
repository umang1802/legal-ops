import type { MemberDto, OrganizationDto, Role } from '@legalops/types';
import type { UpdateOrganizationInput } from '@legalops/validation';
import { query, queryOne, withTransaction, type Db } from '../../db/pool.js';
import { sql } from '../../db/sql.js';
import type { Deps } from '../../deps.js';
import type { RequestMeta, TenantContext } from '../../http/context.js';
import { conflict, forbidden, notFound, validationError } from '../../http/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { emitEvent } from '../outbox/outbox.service.js';

type OrgRow = {
  id: string;
  name: string;
  legal_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  state_code: string | null;
  timezone: string;
  currency: string;
  reminders_enabled: boolean;
  calendar_hide_parties: boolean;
  invoice_prefix: string;
  tax_mode: 'simple' | 'gst';
  gstin: string | null;
  pan: string | null;
  default_send_time: string;
};

const toOrgDto = (o: OrgRow): OrganizationDto => ({
  id: o.id,
  name: o.name,
  legalName: o.legal_name,
  email: o.email,
  phone: o.phone,
  address: o.address,
  city: o.city,
  state: o.state,
  pincode: o.pincode,
  stateCode: o.state_code,
  timezone: o.timezone,
  remindersEnabled: o.reminders_enabled,
  calendarHideParties: o.calendar_hide_parties,
  currency: o.currency,
  invoicePrefix: o.invoice_prefix,
  taxMode: o.tax_mode,
  gstin: o.gstin,
  pan: o.pan,
  defaultSendTime: o.default_send_time.slice(0, 5),
});

const ORG_COLUMNS: Record<keyof UpdateOrganizationInput, string> = {
  name: 'name',
  legalName: 'legal_name',
  email: 'email',
  phone: 'phone',
  address: 'address',
  city: 'city',
  state: 'state',
  pincode: 'pincode',
  stateCode: 'state_code',
  timezone: 'timezone',
  remindersEnabled: 'reminders_enabled',
  calendarHideParties: 'calendar_hide_parties',
  invoicePrefix: 'invoice_prefix',
  taxMode: 'tax_mode',
  gstin: 'gstin',
  pan: 'pan',
  defaultSendTime: 'default_send_time',
};

async function loadOrg(db: Db, organizationId: string, lock = false): Promise<OrgRow> {
  const row = await queryOne<OrgRow>(
    db,
    sql`SELECT id, name, legal_name, email, phone, address, city, state, pincode, state_code, timezone, currency, reminders_enabled, calendar_hide_parties,
               invoice_prefix, tax_mode, gstin, pan, default_send_time::text
        FROM organizations WHERE id = ${organizationId} ${lock ? sql`FOR UPDATE` : sql.empty}`,
  );
  if (!row) throw notFound('Organization');
  return row;
}

export async function getOrganization(deps: Deps, ctx: TenantContext): Promise<OrganizationDto> {
  return toOrgDto(await loadOrg(deps.pool, ctx.organizationId));
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-IN', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function updateOrganization(
  deps: Deps,
  ctx: TenantContext,
  input: UpdateOrganizationInput,
  meta: RequestMeta,
): Promise<OrganizationDto> {
  if (input.timezone && !isValidTimezone(input.timezone)) {
    throw validationError('Unknown timezone', [{ path: 'timezone', message: 'Unknown timezone' }]);
  }
  return withTransaction(deps.pool, async (tx) => {
    const before = await loadOrg(tx, ctx.organizationId, true);
    const merged = {
      taxMode: input.taxMode ?? before.tax_mode,
      gstin: input.gstin !== undefined ? input.gstin : before.gstin,
      stateCode: input.stateCode !== undefined ? input.stateCode : before.state_code,
    };
    if (merged.taxMode === 'gst' && (!merged.gstin || !merged.stateCode)) {
      throw validationError('GST mode needs the firm GSTIN and GST state code', [
        { path: 'gstin', message: 'Required for GST mode' },
      ]);
    }
    if (merged.gstin && merged.stateCode && merged.gstin.slice(0, 2) !== merged.stateCode) {
      throw validationError('GSTIN does not match the GST state code', [
        { path: 'stateCode', message: 'First two digits of the GSTIN must equal the state code' },
      ]);
    }

    const sets = (Object.keys(input) as (keyof UpdateOrganizationInput)[])
      .filter((k) => input[k] !== undefined)
      .map((k) => sql`${sql.raw(ORG_COLUMNS[k])} = ${input[k]}`);
    if (sets.length > 0) {
      await query(tx, sql`UPDATE organizations SET ${sql.join(sets)} WHERE id = ${ctx.organizationId}`);
    }
    const after = await loadOrg(tx, ctx.organizationId);
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'organization.updated',
      entityType: 'organization',
      entityId: ctx.organizationId,
      before,
      after,
      meta,
    });
    return toOrgDto(after);
  });
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

type MemberRow = {
  id: string;
  user_id: string;
  email: string;
  first_name: string;
  last_name: string | null;
  role: Role;
  status: MemberDto['status'];
  joined_at: Date | null;
};

const toMemberDto = (m: MemberRow): MemberDto => ({
  id: m.id,
  userId: m.user_id,
  email: m.email,
  firstName: m.first_name,
  lastName: m.last_name,
  role: m.role,
  status: m.status,
  joinedAt: m.joined_at ? m.joined_at.toISOString() : null,
});

export async function listMembers(deps: Deps, ctx: TenantContext): Promise<MemberDto[]> {
  const rows = await query<MemberRow>(
    deps.pool,
    sql`SELECT m.id, m.user_id, u.email, u.first_name, u.last_name, m.role, m.status, m.joined_at
        FROM organization_members m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = ${ctx.organizationId} AND m.status <> 'removed'
        ORDER BY u.first_name, u.last_name`,
  );
  return rows.map(toMemberDto);
}

export async function inviteMember(
  deps: Deps,
  ctx: TenantContext,
  input: { email: string; role: Role },
  meta: RequestMeta,
): Promise<{ invitationId: string }> {
  if (input.role === 'owner' && ctx.role !== 'owner')
    throw forbidden('Only an owner can invite another owner');
  return withTransaction(deps.pool, async (tx) => {
    const member = await queryOne<{ id: string }>(
      tx,
      sql`SELECT m.id FROM organization_members m JOIN users u ON u.id = m.user_id
          WHERE m.organization_id = ${ctx.organizationId} AND u.email = ${input.email} AND m.status <> 'removed'`,
    );
    if (member) throw conflict('This person is already a member of the firm');

    // Re-inviting replaces any open invitation for the same email.
    await query(
      tx,
      sql`UPDATE invitations SET revoked_at = now()
          WHERE organization_id = ${ctx.organizationId} AND email = ${input.email}
            AND accepted_at IS NULL AND revoked_at IS NULL`,
    );
    const invite = await queryOne<{ id: string }>(
      tx,
      sql`INSERT INTO invitations (organization_id, email, role, invited_by, expires_at)
          VALUES (${ctx.organizationId}, ${input.email}, ${input.role}, ${ctx.userId}, now() + interval '7 days')
          RETURNING id`,
    );
    const invitationId = invite!.id;
    await emitEvent(tx, {
      organizationId: ctx.organizationId,
      eventType: 'MEMBER_INVITED',
      aggregateType: 'invitation',
      aggregateId: invitationId,
      payload: { invitationId, email: input.email, role: input.role },
      actorUserId: ctx.userId,
    });
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'member.invited',
      entityType: 'invitation',
      entityId: invitationId,
      after: input,
      meta,
    });
    return { invitationId };
  });
}

async function activeOwnerCount(db: Db, organizationId: string): Promise<number> {
  const row = await queryOne<{ n: number }>(
    db,
    sql`SELECT count(*)::int AS n FROM organization_members
        WHERE organization_id = ${organizationId} AND role = 'owner' AND status = 'active'`,
  );
  return row?.n ?? 0;
}

export async function updateMember(
  deps: Deps,
  ctx: TenantContext,
  memberId: string,
  input: { role?: Role | undefined; status?: 'active' | 'suspended' | 'removed' | undefined },
  meta: RequestMeta,
): Promise<MemberDto> {
  return withTransaction(deps.pool, async (tx) => {
    // Lock all owner rows so two concurrent demotions can't both pass the last-owner check.
    await query(
      tx,
      sql`SELECT id FROM organization_members WHERE organization_id = ${ctx.organizationId} AND role = 'owner' FOR UPDATE`,
    );
    const before = await queryOne<MemberRow>(
      tx,
      sql`SELECT m.id, m.user_id, u.email, u.first_name, u.last_name, m.role, m.status, m.joined_at
          FROM organization_members m JOIN users u ON u.id = m.user_id
          WHERE m.id = ${memberId} AND m.organization_id = ${ctx.organizationId} AND m.status <> 'removed'
          FOR UPDATE OF m`,
    );
    if (!before) throw notFound('Member');
    if (before.user_id === ctx.userId) throw forbidden('You cannot change your own role or access');
    if (ctx.role !== 'owner' && (before.role === 'owner' || input.role === 'owner')) {
      throw forbidden('Only an owner can change owner access');
    }
    const losesOwner =
      before.role === 'owner' &&
      before.status === 'active' &&
      ((input.role !== undefined && input.role !== 'owner') ||
        (input.status !== undefined && input.status !== 'active'));
    if (losesOwner && (await activeOwnerCount(tx, ctx.organizationId)) <= 1) {
      throw conflict('A firm must keep at least one active owner');
    }

    const after = await queryOne<MemberRow>(
      tx,
      sql`UPDATE organization_members m
          SET role = COALESCE(${input.role ?? null}, m.role), status = COALESCE(${input.status ?? null}, m.status)
          FROM users u
          WHERE m.id = ${memberId} AND u.id = m.user_id
          RETURNING m.id, m.user_id, u.email, u.first_name, u.last_name, m.role, m.status, m.joined_at`,
    );
    if (input.status === 'removed') {
      // Removed members lose their matter assignments.
      await query(
        tx,
        sql`DELETE FROM matter_staff WHERE organization_id = ${ctx.organizationId} AND user_id = ${before.user_id}`,
      );
    }
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: input.status === 'removed' ? 'member.removed' : 'member.updated',
      entityType: 'organization_member',
      entityId: memberId,
      before: { role: before.role, status: before.status },
      after: { role: after!.role, status: after!.status },
      meta,
    });
    return toMemberDto(after!);
  });
}
