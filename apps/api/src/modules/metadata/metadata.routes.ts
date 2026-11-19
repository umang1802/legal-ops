import {
  createMetadataOptionSchema,
  metadataListSchema,
  reorderMetadataOptionsSchema,
  updateMetadataOptionSchema,
  uuidSchema,
} from '@legalops/validation';
import { Router } from 'express';
import type { Deps } from '../../deps.js';
import { parse } from '../../http/validate.js';
import { requestMeta } from '../../middleware/request-context.js';
import { requireAuth, requirePermission, tenant } from '../../middleware/security.js';
import * as metadata from './metadata.service.js';

/**
 * The firm's pick-lists. Any signed-in member can read them (the forms need them); only firm managers change them.
 * Reading a list is not gated by a feature: it is just the choices a form offers.
 */
export function metadataRouter(deps: Deps): Router {
  const r = Router();
  r.use(requireAuth);
  const list = (v: unknown) => parse(metadataListSchema, v);

  r.get('/:list', async (req, res) => {
    res.json({ data: await metadata.listOptions(deps, tenant(req), list(req.params.list)) });
  });
  r.post('/:list', requirePermission('organization.manage'), async (req, res) => {
    res
      .status(201)
      .json({
        data: await metadata.createOption(
          deps,
          tenant(req),
          list(req.params.list),
          parse(createMetadataOptionSchema, req.body),
          requestMeta(req),
        ),
      });
  });
  // Before '/:list/:id' so 'order' isn't read as an id.
  r.post('/:list/order', requirePermission('organization.manage'), async (req, res) => {
    const { ids } = parse(reorderMetadataOptionsSchema, req.body);
    res.json({
      data: await metadata.reorderOptions(deps, tenant(req), list(req.params.list), ids, requestMeta(req)),
    });
  });
  r.patch('/:list/:id', requirePermission('organization.manage'), async (req, res) => {
    res.json({
      data: await metadata.updateOption(
        deps,
        tenant(req),
        list(req.params.list),
        parse(uuidSchema, req.params.id),
        parse(updateMetadataOptionSchema, req.body),
        requestMeta(req),
      ),
    });
  });
  return r;
}
