import { Router } from 'express';
import type { Deps } from '../../deps.js';
import { requireAuth, requirePermission, tenant } from '../../middleware/security.js';
import { getDashboard } from './dashboard.service.js';

export function dashboardRouter(deps: Deps): Router {
  const r = Router();
  r.get('/', requireAuth, requirePermission('dashboard.view'), async (req, res) => {
    res.json({ data: await getDashboard(deps, tenant(req)) });
  });
  return r;
}
