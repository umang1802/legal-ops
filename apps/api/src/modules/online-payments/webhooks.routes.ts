import { uuidSchema } from '@legalops/validation';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Deps } from '../../deps.js';
import { handleZohoWebhook } from './zohopay-webhook.service.js';

/**
 * Public, unauthenticated by design: Zoho cannot sign in. Trust comes only from the HMAC signature, checked against the
 * signing key stored for the firm named in the path. Mounted with a raw body parser, because the signature covers the
 * exact bytes Zoho sent.
 */
export function webhooksRouter(deps: Deps): Router {
  const r = Router();
  r.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false }));
  r.post('/zohopay/:organizationId', async (req, res) => {
    const org = uuidSchema.safeParse(req.params.organizationId);
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!org.success || raw.length === 0) {
      res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Invalid signature' } });
      return;
    }
    const result = await handleZohoWebhook(deps, org.data, raw, req.header('x-zoho-webhook-signature'));
    // Zoho wants a quick 2xx; anything else is retried. 401 for bad signatures, 200 for everything we handled or ignored.
    res
      .status(result.http)
      .json(
        result.http === 200
          ? { ok: true, message: result.message }
          : {
              error: {
                code: result.http === 401 ? 'UNAUTHENTICATED' : 'VALIDATION_ERROR',
                message: result.message,
              },
            },
      );
  });
  return r;
}
