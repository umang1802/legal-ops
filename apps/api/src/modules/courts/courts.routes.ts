import { createCourtSchema } from '@legalops/validation';
import { Router } from 'express';
import { z } from 'zod';
import type { Deps } from '../../deps.js';
import { parse } from '../../http/validate.js';
import { requestMeta } from '../../middleware/request-context.js';
import { requireAuth, requirePermission, tenant } from '../../middleware/security.js';
import * as courts from './courts.service.js';

export function courtsRouter(deps: Deps): Router {
  const r = Router();
  r.use(requireAuth);

  r.get('/', requirePermission('matters.view'), async (req, res) => {
    const { search } = parse(z.object({ search: z.string().trim().max(100).optional() }), req.query);
    res.json({ data: await courts.listCourts(deps, tenant(req), search) });
  });

  r.post('/', requirePermission('matters.create'), async (req, res) => {
    const input = parse(createCourtSchema, req.body);
    res.status(201).json({ data: await courts.createCourt(deps, tenant(req), input, requestMeta(req)) });
  });

  return r;
}
