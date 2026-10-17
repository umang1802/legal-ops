import {
  inviteMemberSchema,
  updateMemberSchema,
  updateOrganizationSchema,
  uuidSchema,
} from '@legalops/validation';
import { Router } from 'express';
import type { Deps } from '../../deps.js';
import { parse } from '../../http/validate.js';
import { requestMeta } from '../../middleware/request-context.js';
import { requireAuth, requirePermission, tenant } from '../../middleware/security.js';
import * as orgs from './organizations.service.js';

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

  // Any member can list colleagues (needed for assignee pickers); management is gated below.
  r.get('/members', requirePermission('dashboard.view'), async (req, res) => {
    res.json({ data: await orgs.listMembers(deps, tenant(req)) });
  });

  r.post('/members/invite', requirePermission('users.manage'), async (req, res) => {
    const input = parse(inviteMemberSchema, req.body);
    res.status(201).json({ data: await orgs.inviteMember(deps, tenant(req), input, requestMeta(req)) });
  });

  r.patch('/members/:memberId', requirePermission('users.manage'), async (req, res) => {
    const memberId = parse(uuidSchema, req.params.memberId);
    const input = parse(updateMemberSchema, req.body);
    res.json({ data: await orgs.updateMember(deps, tenant(req), memberId, input, requestMeta(req)) });
  });

  r.delete('/members/:memberId', requirePermission('users.manage'), async (req, res) => {
    const memberId = parse(uuidSchema, req.params.memberId);
    await orgs.updateMember(deps, tenant(req), memberId, { status: 'removed' }, requestMeta(req));
    res.status(204).end();
  });

  return r;
}
