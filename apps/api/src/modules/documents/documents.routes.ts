import { completeDocumentUploadSchema, downloadDocumentSchema, listDocumentsSchema, startDocumentUploadSchema, uuidSchema } from '@legalops/validation';
import { Router } from 'express';
import type { Deps } from '../../deps.js';
import { parse } from '../../http/validate.js';
import { requestMeta } from '../../middleware/request-context.js';
import { requireAuth, requirePermission, tenant } from '../../middleware/security.js';
import * as documents from './documents.service.js';

export function documentsRouter(deps: Deps): Router {
  const r = Router();
  r.use(requireAuth);
  const id = (raw: unknown) => parse(uuidSchema, raw);

  r.get('/', requirePermission('documents.view'), async (req, res) => {
    res.json({ data: await documents.listDocuments(deps, tenant(req), parse(listDocumentsSchema, req.query)) });
  });
  r.post('/uploads', requirePermission('documents.upload'), async (req, res) => {
    // Signed URLs are credentials: never cache them.
    res.status(201).set('Cache-Control', 'no-store').json({ data: await documents.startUpload(deps, tenant(req), parse(startDocumentUploadSchema, req.body)) });
  });
  r.post('/:documentId/complete', requirePermission('documents.upload'), async (req, res) => {
    res.json({ data: await documents.completeUpload(deps, tenant(req), id(req.params.documentId), parse(completeDocumentUploadSchema, req.body), requestMeta(req)) });
  });
  r.post('/:documentId/abort', requirePermission('documents.upload'), async (req, res) => {
    await documents.abortUpload(deps, tenant(req), id(req.params.documentId));
    res.status(204).end();
  });
  r.get('/:documentId/download', requirePermission('documents.view'), async (req, res) => {
    const { inline } = parse(downloadDocumentSchema, req.query);
    const data = await documents.downloadUrl(deps, tenant(req), id(req.params.documentId), inline === '1' || inline === 'true', requestMeta(req));
    res.set('Cache-Control', 'no-store').json({ data });
  });
  r.delete('/:documentId', requirePermission('documents.upload'), async (req, res) => {
    await documents.deleteDocument(deps, tenant(req), id(req.params.documentId), requestMeta(req));
    res.status(204).end();
  });
  r.post('/:documentId/restore', requirePermission('documents.upload'), async (req, res) => {
    res.json({ data: await documents.restoreDocument(deps, tenant(req), id(req.params.documentId), requestMeta(req)) });
  });
  return r;
}
