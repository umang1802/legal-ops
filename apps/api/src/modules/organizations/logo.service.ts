import { LOGO_TYPES, type LogoContentType, MAX_LOGO_BYTES, type OrganizationDto } from '@legalops/types';
import { randomUUID } from 'node:crypto';
import { type Db, query, queryOne, withTransaction } from '../../db/pool.js';
import { sql } from '../../db/sql.js';
import type { Deps } from '../../deps.js';
import type { RequestMeta, TenantContext } from '../../http/context.js';
import { conflict, notFound, validationError } from '../../http/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { getOrganization } from './organizations.service.js';

const UPLOAD_URL_SECONDS = 300;
const MAGIC: [LogoContentType, Buffer][] = [
  ['image/png', Buffer.from('89504e470d0a1a0a', 'hex')],
  ['image/jpeg', Buffer.from('ffd8ff', 'hex')],
];

/** Where a checked logo lives. Only the API writes here; old files are never deleted (sent emails point at them). */
export const logoKey = (orgId: string, logoId: string, type: string) => `org/${orgId}/branding/${logoId}.${type}`;
/**
 * Where the browser's signed PUT lands. Signed URLs can be reused until they expire and don't pin type or size, so they
 * never point at a served key. The bucket's lifecycle rule expires `incoming/` after a day.
 */
export const logoStagingKey = (orgId: string, logoId: string) => `incoming/logos/${orgId}/${logoId}`;

const detectType = (bytes: Buffer): LogoContentType | null => MAGIC.find(([, m]) => bytes.subarray(0, m.length).equals(m))?.[0] ?? null;

export async function startLogoUpload(deps: Deps, ctx: TenantContext, input: { contentType: LogoContentType }) {
  const logoId = randomUUID();
  const uploadUrl = await deps.storage.signPutUrl(logoStagingKey(ctx.organizationId, logoId), input.contentType, UPLOAD_URL_SECONDS);
  return { logoId, uploadUrl, expiresInSeconds: UPLOAD_URL_SECONDS };
}

/**
 * Checks what the browser uploaded (size, and real PNG/JPEG bytes, whatever it was declared as), writes the checked bytes
 * to the logo's own key itself, removes the staging copy, and makes it the firm's logo.
 */
export async function completeLogoUpload(deps: Deps, ctx: TenantContext, logoId: string, meta: RequestMeta): Promise<OrganizationDto> {
  const staging = logoStagingKey(ctx.organizationId, logoId);
  // A logo's file never changes once checked (its URL is cached for a year), so a used upload can't be completed again.
  if (await isCheckedLogo(deps.pool, ctx.organizationId, logoId)) {
    await deps.storage.remove(staging);
    throw conflict('This upload was already used. Upload the logo again.');
  }
  const bytes = await deps.storage.readObject(staging, MAX_LOGO_BYTES);
  if (!bytes) throw notFound('Upload');
  const refuse = async (message: string) => {
    await deps.storage.remove(staging);
    throw validationError(message);
  };
  if (bytes.length > MAX_LOGO_BYTES) await refuse('Logos can be up to 1 MB');
  const contentType = detectType(bytes);
  if (!contentType) return refuse('That file isn’t a PNG or JPG');
  const type = LOGO_TYPES[contentType];

  await deps.storage.putObject(logoKey(ctx.organizationId, logoId, type), bytes, contentType);
  await deps.storage.remove(staging);
  await withTransaction(deps.pool, async (tx) => {
    await query(tx, sql`INSERT INTO organization_logos (logo_id, organization_id, logo_type) VALUES (${logoId}, ${ctx.organizationId}, ${type})`);
    await query(tx, sql`UPDATE organizations SET logo_id = ${logoId}, logo_type = ${type} WHERE id = ${ctx.organizationId}`);
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'organization.logo_updated',
      entityType: 'organization',
      entityId: ctx.organizationId,
      after: { logoId, type },
      meta,
    });
  });
  return getOrganization(deps, ctx);
}

/** Was this logo accepted by the upload check (optionally: with this type)? Only such files are ever served publicly. */
export async function isCheckedLogo(db: Db, orgId: string, logoId: string, type?: string): Promise<boolean> {
  return Boolean(
    await queryOne(
      db,
      sql`SELECT 1 FROM organization_logos WHERE logo_id = ${logoId} AND organization_id = ${orgId} ${type ? sql`AND logo_type = ${type}` : sql.empty}`,
    ),
  );
}

/** Clears the firm's logo. The file stays, so emails already sent keep showing it. */
export async function removeLogo(deps: Deps, ctx: TenantContext, meta: RequestMeta): Promise<OrganizationDto> {
  await withTransaction(deps.pool, async (tx) => {
    const cleared = await query(
      tx,
      sql`UPDATE organizations SET logo_id = NULL, logo_type = NULL WHERE id = ${ctx.organizationId} AND logo_id IS NOT NULL RETURNING id`,
    );
    if (cleared.length) {
      await recordAudit(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        action: 'organization.logo_removed',
        entityType: 'organization',
        entityId: ctx.organizationId,
        meta,
      });
    }
  });
  return getOrganization(deps, ctx);
}
