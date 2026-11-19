import {
  createHearingTypeSchema,
  reorderHearingTypesSchema,
  updateHearingTypeSchema,
  uuidSchema,
} from '@legalops/validation';
import { Router } from 'express';
import type { Deps } from '../../deps.js';
import { parse } from '../../http/validate.js';
import { requestMeta } from '../../middleware/request-context.js';
import { requireAuth, requirePermission, tenant } from '../../middleware/security.js';
import * as types from './hearing-types.service.js';

/** The firm's hearing types. Anyone who can see matters can read the list (the hearing form needs it); only firm managers change it. */
export function hearingTypesRouter(deps: Deps): Router {
  const r = Router();
  r.use(requireAuth);
  r.get('/', requirePermission('matters.view'), async (req, res) => {
    res.json({ data: await types.listHearingTypes(deps, tenant(req)) });
  });
  r.post('/', requirePermission('organization.manage'), async (req, res) => {
    res
      .status(201)
      .json({
        data: await types.createHearingType(
          deps,
          tenant(req),
          parse(createHearingTypeSchema, req.body),
          requestMeta(req),
        ),
      });
  });
  // Before '/:typeId' so 'order' isn't read as an id.
  r.post('/order', requirePermission('organization.manage'), async (req, res) => {
    const { ids } = parse(reorderHearingTypesSchema, req.body);
    res.json({ data: await types.reorderHearingTypes(deps, tenant(req), ids, requestMeta(req)) });
  });
  r.patch('/:typeId', requirePermission('organization.manage'), async (req, res) => {
    res.json({
      data: await types.updateHearingType(
        deps,
        tenant(req),
        parse(uuidSchema, req.params.typeId),
        parse(updateHearingTypeSchema, req.body),
        requestMeta(req),
      ),
    });
  });
  return r;
}
