import { MAX_LOGO_BYTES } from '@legalops/types';
import { uuidSchema } from '@legalops/validation';
import { Router } from 'express';
import type { Deps } from '../../deps.js';
import { notFound } from '../../http/errors.js';
import { isCheckedLogo, logoKey } from './logo.service.js';

const FILE = /^([0-9a-f-]{36})\.(png|jpg)$/;

/**
 * Firm logos, public so email apps (which can't sign in) can show them. Serves only files that passed the upload check
 * (organization_logos), never whatever else sits under a signed upload URL. Every logo has its own URL, so responses are
 * cached for a year.
 */
export function publicLogoRouter(deps: Deps): Router {
  const r = Router();
  r.get('/logos/:orgId/:file', async (req, res) => {
    const m = FILE.exec(req.params.file);
    if (!m || !uuidSchema.safeParse(req.params.orgId).success || !uuidSchema.safeParse(m[1]).success) throw notFound('Logo');
    if (!(await isCheckedLogo(deps.pool, req.params.orgId, m[1]!, m[2]!))) throw notFound('Logo');
    const bytes = await deps.storage.readObject(logoKey(req.params.orgId, m[1]!, m[2]!), MAX_LOGO_BYTES);
    if (!bytes || bytes.length > MAX_LOGO_BYTES) throw notFound('Logo');
    res
      .set({
        'Content-Type': m[2] === 'png' ? 'image/png' : 'image/jpeg',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'X-Content-Type-Options': 'nosniff',
      })
      .send(bytes);
  });
  return r;
}
