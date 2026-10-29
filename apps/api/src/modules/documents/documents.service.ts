import {
  DOCUMENT_PART_BYTES,
  DOCUMENT_TYPES,
  documentExtension,
  MAX_DOCUMENT_BYTES,
  seesAllMatters,
  type DocumentCategory,
  type DocumentDto,
  type DocumentUploadTicket,
} from '@legalops/types';
import type { completeDocumentUploadSchema, listDocumentsSchema, startDocumentUploadSchema } from '@legalops/validation';
import type { z } from 'zod';
import { query, queryOne, withTransaction, type Db } from '../../db/pool.js';
import { sql, type SqlFragment } from '../../db/sql.js';
import type { Deps } from '../../deps.js';
import type { RequestMeta, TenantContext } from '../../http/context.js';
import { forbidden, notFound, validationError } from '../../http/errors.js';
import { iso, likeContains } from '../../http/query-helpers.js';
import { assertMatterVisible, matterVisible } from '../access/matter-scope.js';
import { recordAudit } from '../audit/audit.service.js';
import { addTimelineEvent } from '../timeline/timeline.service.js';

const PART_URL_SECONDS = 60 * 60;
const DOWNLOAD_URL_SECONDS = 5 * 60;

type Row = {
  id: string;
  matter_id: string;
  case_id: string | null;
  case_number: string | null;
  hearing_id: string | null;
  hearing_date: string | null;
  name: string;
  category: DocumentCategory;
  mime_type: string;
  size_bytes: string;
  status: DocumentDto['status'];
  uploaded_by: string | null;
  first_name: string | null;
  last_name: string | null;
  uploaded_at: Date | null;
  deleted_at: Date | null;
  storage_key: string;
  upload_id: string | null;
};

const SELECT = sql`
  SELECT d.id, d.matter_id, d.case_id, cs.case_number, d.hearing_id, h.scheduled_date::text AS hearing_date, d.name, d.category,
         d.mime_type, d.size_bytes::text AS size_bytes, d.status, d.uploaded_by, u.first_name, u.last_name, d.uploaded_at,
         d.deleted_at, d.storage_key, d.upload_id
  FROM documents d
  JOIN matters m ON m.id = d.matter_id
  LEFT JOIN cases cs ON cs.id = d.case_id
  LEFT JOIN hearings h ON h.id = d.hearing_id
  LEFT JOIN users u ON u.id = d.uploaded_by`;

const toDto = (r: Row): DocumentDto => ({
  id: r.id,
  matterId: r.matter_id,
  caseId: r.case_id,
  caseNumber: r.case_number,
  hearingId: r.hearing_id,
  hearingDate: r.hearing_date,
  name: r.name,
  category: r.category,
  mimeType: r.mime_type,
  sizeBytes: Number(r.size_bytes),
  status: r.status,
  uploadedBy: r.uploaded_by ? { userId: r.uploaded_by, firstName: r.first_name ?? '', lastName: r.last_name } : null,
  uploadedAt: iso(r.uploaded_at),
  deletedAt: iso(r.deleted_at),
});

/** A document the caller can see (matter visibility), or 404. */
async function visibleDocument(db: Db, ctx: TenantContext, id: string, extra: SqlFragment = sql`TRUE`): Promise<Row> {
  const row = await queryOne<Row>(
    db,
    sql`${SELECT} WHERE d.id = ${id} AND d.organization_id = ${ctx.organizationId} AND ${matterVisible(ctx, sql.raw('m.id'))} AND ${extra}`,
  );
  if (!row) throw notFound('Document');
  return row;
}

/** Keeps object keys tidy and URL-safe; the original name is kept in the database and used for downloads. */
const safeKeyName = (name: string) =>
  name.normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(-120) || 'file';

/**
 * Starts a multipart upload and returns signed part URLs for the browser. The document stays 'pending' (and unlisted)
 * until `completeUpload` confirms the stored file.
 */
export async function startUpload(
  deps: Deps,
  ctx: TenantContext,
  input: z.output<typeof startDocumentUploadSchema>,
): Promise<DocumentUploadTicket> {
  await assertMatterVisible(deps.pool, ctx, input.matterId);
  let caseId = input.caseId ?? null;
  if (input.hearingId) {
    const h = await queryOne<{ case_id: string; matter_id: string }>(
      deps.pool,
      sql`SELECT h.case_id, cs.matter_id FROM hearings h JOIN cases cs ON cs.id = h.case_id
          WHERE h.id = ${input.hearingId} AND h.organization_id = ${ctx.organizationId}`,
    );
    if (!h || h.matter_id !== input.matterId || (caseId && caseId !== h.case_id)) {
      throw validationError('That hearing isn’t part of this matter', [{ path: 'hearingId', message: 'Choose a hearing in this matter' }]);
    }
    caseId = h.case_id;
  } else if (caseId) {
    const c = await queryOne<{ id: string }>(
      deps.pool,
      sql`SELECT id FROM cases WHERE id = ${caseId} AND matter_id = ${input.matterId} AND organization_id = ${ctx.organizationId}`,
    );
    if (!c) throw validationError('That case isn’t part of this matter', [{ path: 'caseId', message: 'Choose a case in this matter' }]);
  }

  const id = (await queryOne<{ id: string }>(deps.pool, sql`SELECT gen_random_uuid() AS id`))!.id;
  const key = `org/${ctx.organizationId}/matters/${input.matterId}/${id}/${safeKeyName(input.name)}`;
  const mimeType = DOCUMENT_TYPES[documentExtension(input.name)]!;
  const partCount = Math.max(1, Math.ceil(input.sizeBytes / DOCUMENT_PART_BYTES));
  const { uploadId } = await deps.storage.startUpload(key, mimeType);
  const partUrls = await deps.storage.signPartUrls(key, uploadId, partCount, PART_URL_SECONDS);
  await query(
    deps.pool,
    sql`INSERT INTO documents (id, organization_id, matter_id, case_id, hearing_id, name, category, mime_type, size_bytes,
                               storage_provider, storage_key, upload_id, status, uploaded_by)
        VALUES (${id}, ${ctx.organizationId}, ${input.matterId}, ${caseId}, ${input.hearingId ?? null}, ${input.name},
                ${input.category}, ${mimeType}, ${input.sizeBytes}, ${deps.storage.name}, ${key}, ${uploadId}, 'pending', ${ctx.userId})`,
  );
  return { documentId: id, partSize: DOCUMENT_PART_BYTES, partUrls };
}

/** The uploader's own pending upload, or 404. */
async function ownPending(db: Db, ctx: TenantContext, id: string): Promise<Row> {
  return visibleDocument(db, ctx, id, sql`d.uploaded_by = ${ctx.userId} AND d.status IN ('pending', 'available')`);
}

/**
 * Finishes the multipart upload and verifies the stored size. Signed part URLs don't limit size, so this check is what
 * enforces the declared size and the 500 MB limit: a mismatch deletes the object and fails the document.
 */
export async function completeUpload(
  deps: Deps,
  ctx: TenantContext,
  id: string,
  input: z.output<typeof completeDocumentUploadSchema>,
  meta: RequestMeta,
): Promise<DocumentDto> {
  const doc = await ownPending(deps.pool, ctx, id);
  if (doc.status === 'available') return toDto(doc); // a retried "complete" is harmless
  await deps.storage.completeUpload(doc.storage_key, doc.upload_id!, input.parts);
  const size = await deps.storage.objectSize(doc.storage_key);
  if (size === null || size !== Number(doc.size_bytes) || size > MAX_DOCUMENT_BYTES) {
    if (size !== null) await deps.storage.remove(doc.storage_key);
    await query(deps.pool, sql`UPDATE documents SET status = 'failed', upload_id = NULL WHERE id = ${id}`);
    throw validationError('The uploaded file didn’t match what was expected. Please upload it again.', [{ path: 'file', message: 'Upload incomplete or changed' }]);
  }
  await withTransaction(deps.pool, async (tx) => {
    await query(tx, sql`UPDATE documents SET status = 'available', upload_id = NULL, uploaded_at = now() WHERE id = ${id}`);
    await addTimelineEvent(tx, {
      organizationId: ctx.organizationId,
      matterId: doc.matter_id,
      caseId: doc.case_id,
      eventType: 'document.uploaded',
      title: `Document added: ${doc.name}`,
      description: doc.hearing_date ? `Filed against the hearing on ${doc.hearing_date}` : null,
      actorUserId: ctx.userId,
      sourceType: 'document',
      sourceId: id,
    });
    await recordAudit(tx, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: 'document.uploaded', entityType: 'document', entityId: id, after: { name: doc.name, category: doc.category, sizeBytes: size }, meta });
  });
  return toDto(await visibleDocument(deps.pool, ctx, id));
}

export async function abortUpload(deps: Deps, ctx: TenantContext, id: string): Promise<void> {
  const doc = await visibleDocument(deps.pool, ctx, id, sql`d.uploaded_by = ${ctx.userId} AND d.status = 'pending'`);
  if (doc.upload_id) await deps.storage.abortUpload(doc.storage_key, doc.upload_id);
  await query(deps.pool, sql`UPDATE documents SET status = 'failed', upload_id = NULL WHERE id = ${id}`);
}

export async function listDocuments(deps: Deps, ctx: TenantContext, f: z.output<typeof listDocumentsSchema>): Promise<DocumentDto[]> {
  if (f.matterId) await assertMatterVisible(deps.pool, ctx, f.matterId);
  const where: SqlFragment[] = [
    sql`d.organization_id = ${ctx.organizationId}`,
    matterVisible(ctx, sql.raw('m.id')),
    f.includeDeleted && seesAllMatters(ctx.role) ? sql`d.status IN ('available', 'deleted')` : sql`d.status = 'available'`,
  ];
  if (f.matterId) where.push(sql`d.matter_id = ${f.matterId}`);
  if (f.hearingId) where.push(sql`d.hearing_id = ${f.hearingId}`);
  if (f.caseId) where.push(sql`d.case_id = ${f.caseId}`);
  if (f.category) where.push(sql`d.category = ${f.category}`);
  if (f.search) where.push(sql`d.name ILIKE ${likeContains(f.search)}`);
  const rows = await query<Row>(deps.pool, sql`${SELECT} WHERE ${sql.join(where, ' AND ')} ORDER BY d.uploaded_at DESC NULLS LAST, d.name LIMIT 1000`);
  return rows.map(toDto);
}

/** A 5-minute signed link. Every download is recorded in the audit log. */
export async function downloadUrl(deps: Deps, ctx: TenantContext, id: string, inline: boolean, meta: RequestMeta): Promise<{ url: string }> {
  const doc = await visibleDocument(deps.pool, ctx, id, sql`d.status = 'available'`);
  const url = await deps.storage.signDownloadUrl(doc.storage_key, { fileName: doc.name, contentType: doc.mime_type, inline, expiresInSeconds: DOWNLOAD_URL_SECONDS });
  await recordAudit(deps.pool, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: 'document.downloaded', entityType: 'document', entityId: id, meta });
  return { url };
}

const isFirmAdmin = (ctx: TenantContext) => ctx.role === 'owner' || ctx.role === 'admin';

/** Soft delete: hidden from lists, the file is kept, and an owner or admin can restore it. */
export async function deleteDocument(deps: Deps, ctx: TenantContext, id: string, meta: RequestMeta): Promise<void> {
  const doc = await visibleDocument(deps.pool, ctx, id, sql`d.status = 'available'`);
  if (doc.uploaded_by !== ctx.userId && !isFirmAdmin(ctx)) throw forbidden('Only the person who uploaded this, or a partner, can delete it');
  await withTransaction(deps.pool, async (tx) => {
    await query(tx, sql`UPDATE documents SET status = 'deleted', deleted_at = now(), deleted_by = ${ctx.userId} WHERE id = ${id}`);
    await addTimelineEvent(tx, { organizationId: ctx.organizationId, matterId: doc.matter_id, caseId: doc.case_id, eventType: 'document.deleted', title: `Document deleted: ${doc.name}`, actorUserId: ctx.userId, sourceType: 'document', sourceId: id });
    await recordAudit(tx, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: 'document.deleted', entityType: 'document', entityId: id, before: { name: doc.name }, meta });
  });
}

export async function restoreDocument(deps: Deps, ctx: TenantContext, id: string, meta: RequestMeta): Promise<DocumentDto> {
  if (!isFirmAdmin(ctx)) throw forbidden('Only a partner or admin can restore a deleted document');
  const doc = await visibleDocument(deps.pool, ctx, id, sql`d.status = 'deleted'`);
  await withTransaction(deps.pool, async (tx) => {
    await query(tx, sql`UPDATE documents SET status = 'available', deleted_at = NULL, deleted_by = NULL WHERE id = ${id}`);
    await addTimelineEvent(tx, { organizationId: ctx.organizationId, matterId: doc.matter_id, caseId: doc.case_id, eventType: 'document.restored', title: `Document restored: ${doc.name}`, actorUserId: ctx.userId, sourceType: 'document', sourceId: id });
    await recordAudit(tx, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: 'document.restored', entityType: 'document', entityId: id, meta });
  });
  return toDto(await visibleDocument(deps.pool, ctx, id));
}
