import {
  advocateSchema,
  createCaseSchema,
  listCasesSchema,
  partySchema,
  updateCaseSchema,
  uuidSchema,
} from '@legalops/validation';
import { Router } from 'express';
import type { Deps } from '../../deps.js';
import { parse } from '../../http/validate.js';
import type { CourtDataProvider } from '../../integrations/courts/court-provider.js';
import { requestMeta } from '../../middleware/request-context.js';
import { requireAuth, requirePermission, tenant } from '../../middleware/security.js';
import * as cases from './cases.service.js';

/**
 * Permissions: adding things under a matter you can see = matters.create (staff can do this);
 * changing or removing them = matters.edit.
 */
export function casesRouter(deps: Deps & { courts: CourtDataProvider }): Router {
  const r = Router();
  r.use(requireAuth);

  r.get('/', requirePermission('matters.view'), async (req, res) => {
    const f = parse(listCasesSchema, req.query);
    res.json({ data: await cases.listCases(deps.pool, tenant(req), f) });
  });

  r.post('/', requirePermission('matters.create'), async (req, res) => {
    const input = parse(createCaseSchema, req.body);
    res.status(201).json({ data: await cases.createCase(deps, tenant(req), input, requestMeta(req)) });
  });

  r.get('/:caseId', requirePermission('matters.view'), async (req, res) => {
    const id = parse(uuidSchema, req.params.caseId);
    res.json({ data: await cases.getCase(deps.pool, tenant(req), id) });
  });

  r.patch('/:caseId', requirePermission('matters.edit'), async (req, res) => {
    const id = parse(uuidSchema, req.params.caseId);
    const input = parse(updateCaseSchema, req.body);
    res.json({ data: await cases.updateCase(deps, tenant(req), id, input, requestMeta(req)) });
  });

  r.get('/:caseId/parties', requirePermission('matters.view'), async (req, res) => {
    const id = parse(uuidSchema, req.params.caseId);
    res.json({ data: (await cases.getCase(deps.pool, tenant(req), id)).parties });
  });

  r.post('/:caseId/parties', requirePermission('matters.create'), async (req, res) => {
    const id = parse(uuidSchema, req.params.caseId);
    const input = parse(partySchema, req.body);
    res.status(201).json({ data: await cases.addParty(deps, tenant(req), id, input, requestMeta(req)) });
  });

  r.patch('/:caseId/parties/:partyId', requirePermission('matters.edit'), async (req, res) => {
    const id = parse(uuidSchema, req.params.caseId);
    const partyId = parse(uuidSchema, req.params.partyId);
    const input = parse(partySchema, req.body);
    res.json({ data: await cases.updateParty(deps, tenant(req), id, partyId, input, requestMeta(req)) });
  });

  r.delete('/:caseId/parties/:partyId', requirePermission('matters.edit'), async (req, res) => {
    const id = parse(uuidSchema, req.params.caseId);
    const partyId = parse(uuidSchema, req.params.partyId);
    await cases.removeParty(deps, tenant(req), id, partyId, requestMeta(req));
    res.status(204).end();
  });

  r.get('/:caseId/advocates', requirePermission('matters.view'), async (req, res) => {
    const id = parse(uuidSchema, req.params.caseId);
    res.json({ data: (await cases.getCase(deps.pool, tenant(req), id)).advocates });
  });

  r.post('/:caseId/advocates', requirePermission('matters.create'), async (req, res) => {
    const id = parse(uuidSchema, req.params.caseId);
    const input = parse(advocateSchema, req.body);
    res.status(201).json({ data: await cases.addAdvocate(deps, tenant(req), id, input, requestMeta(req)) });
  });

  r.delete('/:caseId/advocates/:advocateId', requirePermission('matters.edit'), async (req, res) => {
    const id = parse(uuidSchema, req.params.caseId);
    const advocateId = parse(uuidSchema, req.params.advocateId);
    await cases.removeAdvocate(deps, tenant(req), id, advocateId, requestMeta(req));
    res.status(204).end();
  });

  r.post('/:caseId/refresh', requirePermission('matters.view'), async (req, res) => {
    const id = parse(uuidSchema, req.params.caseId);
    await cases.refreshCase(deps, tenant(req), id);
    res.status(204).end();
  });

  return r;
}
