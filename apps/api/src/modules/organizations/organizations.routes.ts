import {
  completeLogoUploadSchema,
  inviteMemberSchema,
  startLogoUploadSchema,
  startSignatureUploadSchema,
  updateMemberSchema,
  updateOrganizationSchema,
  uuidSchema,
} from '@legalops/validation';
import { Router } from 'express';
import type { Deps } from '../../deps.js';
import { parse } from '../../http/validate.js';
import { requestMeta } from '../../middleware/request-context.js';
import { requireAuth, requirePermission, tenant } from '../../middleware/security.js';
import * as logo from './logo.service.js';
import * as orgs from './organizations.service.js';
import * as signature from './signature.service.js';

export function organizationRouter(deps: Deps): Router {
  const r = Router();
  r.use(requireAuth);

  r.get('/', async (req, res) => {
    res.json({ data: await orgs.getOrganization(deps, tenant(req)) });
  });

  r.patch('/', requirePermission('organization.manage'), async (req, res) => {
    const input = parse(updateOrganizationSchema, req.body);
    res.json({ data: await orgs.updateOrganization(deps, tenant(req), input, requestMeta(req)) });
  });

  r.post('/logo/uploads', requirePermission('organization.manage'), async (req, res) => {
    const input = parse(startLogoUploadSchema, req.body);
    res.status(201).set('Cache-Control', 'no-store').json({ data: await logo.startLogoUpload(deps, tenant(req), input) });
  });
  r.post('/logo/:logoId/complete', requirePermission('organization.manage'), async (req, res) => {
    parse(completeLogoUploadSchema, req.body ?? {});
    res.json({ data: await logo.completeLogoUpload(deps, tenant(req), parse(uuidSchema, req.params.logoId), requestMeta(req)) });
  });
  r.delete('/logo', requirePermission('organization.manage'), async (req, res) => {
    res.json({ data: await logo.removeLogo(deps, tenant(req), requestMeta(req)) });
  });

  // Any member can list colleagues (needed for assignee pickers); management is gated below.
  r.get('/members', requirePermission('dashboard.view'), async (req, res) => {
    res.json({ data: await orgs.listMembers(deps, tenant(req)) });
  });

  r.post('/members/invite', requirePermission('users.manage'), async (req, res) => {
    const input = parse(inviteMemberSchema, req.body);
    res.status(201).json({ data: await orgs.inviteMember(deps, tenant(req), input, requestMeta(req)) });
  });

  // Role/status need users.manage; a designation can also be set by the member themself (checked in the service).
  r.patch('/members/:memberId', async (req, res) => {
    const memberId = parse(uuidSchema, req.params.memberId);
    const input = parse(updateMemberSchema, req.body);
    res.json({ data: await orgs.updateMember(deps, tenant(req), memberId, input, requestMeta(req)) });
  });

  // Scanned signature: a member manages their own, users.manage for anyone's (checked in the service).
  r.post('/members/:memberId/signature/uploads', async (req, res) => {
    const input = parse(startSignatureUploadSchema, req.body);
    const memberId = parse(uuidSchema, req.params.memberId);
    res.status(201).set('Cache-Control', 'no-store').json({ data: await signature.startSignatureUpload(deps, tenant(req), memberId, input.contentType) });
  });
  r.post('/members/:memberId/signature/uploads/:uploadId/complete', async (req, res) => {
    parse(completeLogoUploadSchema, req.body ?? {});
    const memberId = parse(uuidSchema, req.params.memberId);
    const uploadId = parse(uuidSchema, req.params.uploadId);
    res.json({ data: await signature.completeSignatureUpload(deps, tenant(req), memberId, uploadId, requestMeta(req)) });
  });
  r.delete('/members/:memberId/signature', async (req, res) => {
    res.json({ data: await signature.removeSignature(deps, tenant(req), parse(uuidSchema, req.params.memberId), requestMeta(req)) });
  });
  r.get('/members/:memberId/signature', async (req, res) => {
    const file = await signature.readSignature(deps, tenant(req), parse(uuidSchema, req.params.memberId));
    res.set({ 'Content-Type': file.contentType, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }).send(file.bytes);
  });

  r.delete('/members/:memberId', requirePermission('users.manage'), async (req, res) => {
    const memberId = parse(uuidSchema, req.params.memberId);
    await orgs.updateMember(deps, tenant(req), memberId, { status: 'removed' }, requestMeta(req));
    res.status(204).end();
  });

  return r;
}
