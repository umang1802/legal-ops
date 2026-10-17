import { searchSchema } from '@legalops/validation';
import { Router } from 'express';
import type { Deps } from '../../deps.js';
import { parse } from '../../http/validate.js';
import { requireAuth, requirePermission, tenant } from '../../middleware/security.js';
import { search } from './search.service.js';

export function searchRouter(deps: Deps): Router {
  const r = Router();
  r.get('/', requireAuth, requirePermission('dashboard.view'), async (req, res) => {
    const { q } = parse(searchSchema, req.query);
    res.json({ data: await search(deps, tenant(req), q) });
  });
  return r;
}
