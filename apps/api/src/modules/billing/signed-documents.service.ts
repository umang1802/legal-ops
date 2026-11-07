import { randomUUID } from 'node:crypto';
import { type Db, query, queryOne, withTransaction } from '../../db/pool.js';
import { sql } from '../../db/sql.js';
import type { Deps } from '../../deps.js';
import type { RequestMeta, TenantContext } from '../../http/context.js';
import { conflict, notFound, validationError } from '../../http/errors.js';
import { iso } from '../../http/query-helpers.js';
import { recordAudit } from '../audit/audit.service.js';
import { isPdf, looksDigitallySigned, MAX_SIGNED_PDF_BYTES } from './dsc-check.js';
import { invoiceVisible } from './visibility.js';

const UPLOAD_URL_SECONDS = 300;

/** Where the browser's signed PUT lands (the bucket expires `incoming/` after a day). */
export const signedStagingKey = (orgId: string, invoiceId: string, uploadId: string) => `incoming/signed/${orgId}/${invoiceId}/${uploadId}`;
export const signedKey = (orgId: string, invoiceId: string, revision: number, uuid: string) =>
  `signed/${orgId}/${invoiceId}/${revision}-${uuid}.pdf`;

export type ActiveSigned = { id: string; storageKey: string; sizeBytes: number; uploadedAt: string; uploadedBy: { userId: string; firstName: string; lastName: string | null } | null };

/**
 * The invoice's active DSC-signed PDF, only while it was uploaded for the invoice's CURRENT revision. After a revision the
 * signed copy is stale (it shows the old numbers), so callers fall back to the generated PDF.
 */
export async function activeSignedDocument(db: Db, invoiceId: string): Promise<ActiveSigned | null> {
  const r = await queryOne<{ id: string; storage_key: string; size_bytes: string; uploaded_at: Date; uid: string | null; first_name: string | null; last_name: string | null }>(
    db,
    sql`SELECT s.id, s.storage_key, s.size_bytes::text, s.uploaded_at, u.id AS uid, u.first_name, u.last_name
        FROM invoice_signed_documents s
        JOIN invoices i ON i.id = s.invoice_id AND i.organization_id = s.organization_id
        LEFT JOIN users u ON u.id = s.uploaded_by
        WHERE s.invoice_id = ${invoiceId} AND s.superseded_at IS NULL AND s.revision = i.revision AND i.status = 'issued'`,
  );
  if (!r) return null;
  return {
    id: r.id,
    storageKey: r.storage_key,
    sizeBytes: Number(r.size_bytes),
    uploadedAt: iso(r.uploaded_at)!,
    uploadedBy: r.uid ? { userId: r.uid, firstName: r.first_name ?? '', lastName: r.last_name } : null,
  };
}

/** Only issued invoices take a signed copy; the caller must see the invoice's matter. Returns the current revision. */
async function assertAccepting(db: Db, ctx: TenantContext, invoiceId: string): Promise<number> {
  const inv = await queryOne<{ status: string; revision: number }>(
    db,
    sql`SELECT i.status, i.revision FROM invoices i WHERE i.id = ${invoiceId} AND i.organization_id = ${ctx.organizationId} AND ${invoiceVisible(ctx)}`,
  );
  if (!inv) throw notFound('Invoice');
  if (inv.status !== 'issued') throw conflict('Only an issued invoice can have a signed copy.');
  return inv.revision;
}

export async function startSignedUpload(deps: Deps, ctx: TenantContext, invoiceId: string) {
  await assertAccepting(deps.pool, ctx, invoiceId);
  const uploadId = randomUUID();
  const url = await deps.storage.signPutUrl(signedStagingKey(ctx.organizationId, invoiceId, uploadId), 'application/pdf', UPLOAD_URL_SECONDS);
  return { uploadId, url };
}

export async function completeSignedUpload(deps: Deps, ctx: TenantContext, invoiceId: string, uploadId: string, meta: RequestMeta) {
  const staging = signedStagingKey(ctx.organizationId, invoiceId, uploadId);
  const revision = await assertAccepting(deps.pool, ctx, invoiceId);
  const bytes = await deps.storage.readObject(staging, MAX_SIGNED_PDF_BYTES);
  if (!bytes) throw notFound('Upload');
  const refuse = async (message: string) => {
    await deps.storage.remove(staging);
    throw validationError(message);
  };
  if (bytes.length > MAX_SIGNED_PDF_BYTES) return refuse('The signed PDF can be up to 10 MB');
  if (!isPdf(bytes)) return refuse('That file is not a PDF');
  if (!looksDigitallySigned(bytes))
    return refuse('This PDF has no digital signature. Sign it with the DSC (e.g. in Adobe Acrobat or emSigner) and upload the signed file.');

  const key = signedKey(ctx.organizationId, invoiceId, revision, randomUUID());
  await deps.storage.putObject(key, bytes, 'application/pdf');
  await deps.storage.remove(staging);
  await withTransaction(deps.pool, async (tx) => {
    // The invoice may have changed since the pre-check; lock and re-read so the row carries the revision it was uploaded for.
    const cur = await queryOne<{ status: string; revision: number }>(tx, sql`SELECT status, revision FROM invoices WHERE id = ${invoiceId} AND organization_id = ${ctx.organizationId} FOR UPDATE`);
    if (!cur || cur.status !== 'issued' || cur.revision !== revision) throw conflict('The invoice changed while uploading. Upload the signed copy again.');
    await query(tx, sql`UPDATE invoice_signed_documents SET superseded_at = now() WHERE invoice_id = ${invoiceId} AND superseded_at IS NULL`);
    await query(
      tx,
      sql`INSERT INTO invoice_signed_documents (organization_id, invoice_id, revision, storage_key, size_bytes, uploaded_by)
          VALUES (${ctx.organizationId}, ${invoiceId}, ${revision}, ${key}, ${bytes.length}, ${ctx.userId})`,
    );
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'invoice.signed_document_uploaded',
      entityType: 'invoice',
      entityId: invoiceId,
      after: { revision, sizeBytes: bytes.length },
      meta,
    });
  });
}

/** Unlinks the active signed copy (the file stays, like logos). */
export async function removeSignedDocument(deps: Deps, ctx: TenantContext, invoiceId: string, meta: RequestMeta) {
  const inv = await queryOne(deps.pool, sql`SELECT 1 FROM invoices i WHERE i.id = ${invoiceId} AND i.organization_id = ${ctx.organizationId} AND ${invoiceVisible(ctx)}`);
  if (!inv) throw notFound('Invoice');
  await withTransaction(deps.pool, async (tx) => {
    const done = await query(
      tx,
      sql`UPDATE invoice_signed_documents SET superseded_at = now() WHERE invoice_id = ${invoiceId} AND organization_id = ${ctx.organizationId} AND superseded_at IS NULL RETURNING id`,
    );
    if (done.length)
      await recordAudit(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        action: 'invoice.signed_document_removed',
        entityType: 'invoice',
        entityId: invoiceId,
        meta,
      });
  });
}
