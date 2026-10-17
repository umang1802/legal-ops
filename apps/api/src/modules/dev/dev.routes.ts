import { Router } from 'express';
import { z } from 'zod';
import type { Deps } from '../../deps.js';
import { parse } from '../../http/validate.js';
import { requireAuth, requirePermission } from '../../middleware/security.js';
import { tick } from '../workflows/processor.js';

/**
 * Dev/test only (never mounted in production): the pilot's "test clock". Runs one worker pass as
 * if it were `asOf`: relay events, run due automations, send due emails (to Mailpit in dev).
 */
export function devRouter(deps: Deps): Router {
  const r = Router();
  r.use(requireAuth, requirePermission('organization.manage'));
  r.post('/worker/tick', async (req, res) => {
    const { asOf } = parse(z.object({ asOf: z.iso.datetime({ offset: true }).optional() }).strict(), req.body ?? {});
    const now = asOf ? new Date(asOf) : new Date();
    res.json({ data: { asOf: now.toISOString(), ...(await tick(deps, now)) } });
  });
  return r;
}
