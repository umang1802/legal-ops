import {
  cancelHearingSchema,
  completeHearingSchema,
  createHearingSchema,
  listHearingsSchema,
  updateHearingSchema,
  uuidSchema,
} from '@legalops/validation';
import { Router } from 'express';
import type { Deps } from '../../deps.js';
import { parse } from '../../http/validate.js';
import { requestMeta } from '../../middleware/request-context.js';
import { requireAuth, requirePermission, tenant } from '../../middleware/security.js';
import * as hearings from './hearings.service.js';

export function hearingsRouter(deps: Deps): Router {
  const r = Router();
  r.use(requireAuth);

  r.get('/', requirePermission('matters.view'), async (req, res) => {
    const f = parse(listHearingsSchema, req.query);
    res.json({ data: await hearings.listHearings(deps, tenant(req), f) });
  });

  r.post('/', requirePermission('hearings.manage'), async (req, res) => {
    const input = parse(createHearingSchema, req.body);
    res.status(201).json({ data: await hearings.createHearing(deps, tenant(req), input, requestMeta(req)) });
  });

  r.get('/:hearingId', requirePermission('matters.view'), async (req, res) => {
    const id = parse(uuidSchema, req.params.hearingId);
    res.json({ data: await hearings.getHearing(deps.pool, tenant(req), id) });
  });

  r.patch('/:hearingId', requirePermission('hearings.manage'), async (req, res) => {
    const id = parse(uuidSchema, req.params.hearingId);
    const input = parse(updateHearingSchema, req.body);
    res.json({ data: await hearings.updateHearing(deps, tenant(req), id, input, requestMeta(req)) });
  });

  r.post('/:hearingId/complete', requirePermission('hearings.manage'), async (req, res) => {
    const id = parse(uuidSchema, req.params.hearingId);
    const input = parse(completeHearingSchema, req.body);
    res.json({ data: await hearings.completeHearing(deps, tenant(req), id, input, requestMeta(req)) });
  });

  r.post('/:hearingId/cancel', requirePermission('hearings.manage'), async (req, res) => {
    const id = parse(uuidSchema, req.params.hearingId);
    const { reason } = parse(cancelHearingSchema, req.body);
    res.json({ data: await hearings.cancelHearing(deps, tenant(req), id, reason, requestMeta(req)) });
  });

  return r;
}
