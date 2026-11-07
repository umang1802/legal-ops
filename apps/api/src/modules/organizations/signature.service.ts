import { LOGO_TYPES, type LogoContentType, MAX_SIGNATURE_BYTES, type MemberDto } from '@legalops/types';
import { randomUUID } from 'node:crypto';
import { type Db, query, queryOne, withTransaction } from '../../db/pool.js';
import { sql } from '../../db/sql.js';
import type { Deps } from '../../deps.js';
import type { RequestMeta, TenantContext } from '../../http/context.js';
import { forbidden, notFound, validationError } from '../../http/errors.js';
import { allowed } from '../../middleware/security.js';
import { recordAudit } from '../audit/audit.service.js';
import { detectType } from './logo.service.js';
import { getMember } from './organizations.service.js';

const UPLOAD_URL_SECONDS = 300;

/**
 * Where the browser's signed PUT lands. The key carries the target user, so an upload started for one member can never be
 * completed for another. The bucket's lifecycle rule expires `incoming/` after a day.
 */
export const signatureStagingKey = (orgId: string, userId: string, uploadId: string) => `incoming/signatures/${orgId}/${userId}/${uploadId}`;
/** A checked signature's own key. Never deleted: issued invoices keep pointing at it. */
export const signatureKey = (orgId: string, userId: string, uuid: string, ext: string) => `signatures/${orgId}/${userId}/${uuid}.${ext}`;

/** The member's user id, if the member belongs to the caller's firm and the caller may manage their signature. */
async function targetUser(db: Db, ctx: TenantContext, memberId: string): Promise<string> {
  const m = await queryOne<{ user_id: string }>(
    db,
    sql`SELECT user_id FROM organization_members WHERE id = ${memberId} AND organization_id = ${ctx.organizationId} AND status <> 'removed'`,
  );
  if (!m) throw notFound('Member');
  if (m.user_id !== ctx.userId && !allowed(ctx, 'users.manage')) throw forbidden();
  return m.user_id;
}

export async function startSignatureUpload(deps: Deps, ctx: TenantContext, memberId: string, contentType: LogoContentType) {
  const userId = await targetUser(deps.pool, ctx, memberId);
  const uploadId = randomUUID();
  const uploadUrl = await deps.storage.signPutUrl(signatureStagingKey(ctx.organizationId, userId, uploadId), contentType, UPLOAD_URL_SECONDS);
  return { uploadId, uploadUrl, expiresInSeconds: UPLOAD_URL_SECONDS };
}

/** Checks what the browser uploaded (size, real PNG/JPEG bytes), writes the checked bytes to the final key itself, and points the member at it. */
export async function completeSignatureUpload(deps: Deps, ctx: TenantContext, memberId: string, uploadId: string, meta: RequestMeta): Promise<MemberDto> {
  const userId = await targetUser(deps.pool, ctx, memberId);
  const staging = signatureStagingKey(ctx.organizationId, userId, uploadId);
  const bytes = await deps.storage.readObject(staging, MAX_SIGNATURE_BYTES);
  if (!bytes) throw notFound('Upload');
  const refuse = async (message: string) => {
    await deps.storage.remove(staging);
    throw validationError(message);
  };
  if (bytes.length > MAX_SIGNATURE_BYTES) return refuse('Signature images can be up to 500 KB');
  const contentType = detectType(bytes);
  if (!contentType) return refuse('That file isn’t a PNG or JPG');
  const ext = LOGO_TYPES[contentType];

  const key = signatureKey(ctx.organizationId, userId, randomUUID(), ext);
  await deps.storage.putObject(key, bytes, contentType);
  await deps.storage.remove(staging);
  await withTransaction(deps.pool, async (tx) => {
    await query(tx, sql`UPDATE organization_members SET signature_key = ${key}, signature_type = ${ext} WHERE id = ${memberId} AND organization_id = ${ctx.organizationId}`);
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'member.signature_updated',
      entityType: 'organization_member',
      entityId: memberId,
      after: { type: ext },
      meta,
    });
  });
  return (await getMember(deps.pool, ctx.organizationId, memberId))!;
}

/** Clears the member's pointer only. The file stays: invoices issued with it still print it. */
export async function removeSignature(deps: Deps, ctx: TenantContext, memberId: string, meta: RequestMeta): Promise<MemberDto> {
  await targetUser(deps.pool, ctx, memberId);
  await withTransaction(deps.pool, async (tx) => {
    const cleared = await query(
      tx,
      sql`UPDATE organization_members SET signature_key = NULL, signature_type = NULL
          WHERE id = ${memberId} AND organization_id = ${ctx.organizationId} AND signature_key IS NOT NULL RETURNING id`,
    );
    if (cleared.length)
      await recordAudit(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        action: 'member.signature_removed',
        entityType: 'organization_member',
        entityId: memberId,
        meta,
      });
  });
  return (await getMember(deps.pool, ctx.organizationId, memberId))!;
}

/** The image for the web preview: any member of the firm may look, nobody else. */
export async function readSignature(deps: Deps, ctx: TenantContext, memberId: string): Promise<{ bytes: Buffer; contentType: LogoContentType }> {
  const m = await queryOne<{ signature_key: string | null }>(
    deps.pool,
    sql`SELECT signature_key FROM organization_members WHERE id = ${memberId} AND organization_id = ${ctx.organizationId} AND status <> 'removed'`,
  );
  if (!m?.signature_key) throw notFound('Signature');
  const bytes = await deps.storage.readObject(m.signature_key, MAX_SIGNATURE_BYTES);
  const contentType = bytes ? detectType(bytes) : null;
  if (!bytes || !contentType) throw notFound('Signature');
  return { bytes, contentType };
}

export type SignatoryColumns = {
  userId: string | null;
  name: string | null;
  designation: string | null;
  signatureKey: string | null;
  withImage: boolean;
};

const PLACEHOLDER = 'Authorized Signatory';

/**
 * Freezes who signs an invoice, taken at issue. The signature key is copied from the member's CURRENT pointer, so later
 * edits or removal never change an issued invoice (the object itself is never deleted).
 * Default: the issuer if they have set a designation (or uploaded a signature), else the matter's lead, else nobody.
 */
export async function snapshotSignatory(
  db: Db,
  orgId: string,
  userId: string | undefined,
  issuerId: string,
  withImage: boolean,
  matterId: string,
): Promise<SignatoryColumns> {
  type Row = { user_id: string; name: string; designation: string; signature_key: string | null };
  const load = async (uid: string): Promise<Row | null> =>
    (await queryOne<Row>(
      db,
      sql`SELECT m.user_id, trim(u.first_name || ' ' || coalesce(u.last_name, '')) AS name, m.designation, m.signature_key
          FROM organization_members m JOIN users u ON u.id = m.user_id
          WHERE m.organization_id = ${orgId} AND m.user_id = ${uid} AND m.status = 'active'`,
    )) ?? null;
  let who: Row | null | undefined = null;
  if (userId) {
    who = await load(userId);
    if (!who) throw validationError('The signatory must be an active member of your firm', [{ path: 'signatoryUserId', message: 'Not an active member' }]);
  } else {
    const issuer = await load(issuerId);
    if (issuer && (issuer.designation !== PLACEHOLDER || issuer.signature_key !== null)) who = issuer;
    else {
      const lead = await queryOne<{ user_id: string }>(
        db,
        sql`SELECT user_id FROM matter_staff WHERE matter_id = ${matterId} AND organization_id = ${orgId} AND role = 'lead'`,
      );
      who = lead ? await load(lead.user_id) : null;
    }
  }
  if (withImage && !who?.signature_key)
    throw validationError(who ? `${who.name} has no scanned signature. Upload one or issue without the image.` : 'There is no signatory to print a signature for', [
      { path: 'signWithImage', message: 'No signature available' },
    ]);
  if (!who) return { userId: null, name: null, designation: null, signatureKey: null, withImage: false };
  return { userId: who.user_id, name: who.name, designation: who.designation, signatureKey: who.signature_key, withImage };
}
