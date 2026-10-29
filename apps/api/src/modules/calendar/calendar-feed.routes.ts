import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Deps } from '../../deps.js';
import { requestMeta } from '../../middleware/request-context.js';
import { requireAuth, requirePermission, tenant } from '../../middleware/security.js';
import * as feeds from './calendar-feed.service.js';

/** The signed-in user's own subscribe link: status, create/reset, turn off. */
export function calendarFeedRouter(deps: Deps): Router {
  const r = Router();
  r.use(requireAuth, requirePermission('matters.view'));
  r.get('/', async (req, res) => {
    res.json({ data: await feeds.getFeedStatus(deps, tenant(req)) });
  });
  r.post('/', async (req, res) => {
    // The URL is a credential: show it once, cache it nowhere.
    res.status(201).set('Cache-Control', 'no-store').json({ data: await feeds.createOrResetFeed(deps, tenant(req), requestMeta(req)) });
  });
  r.delete('/', async (req, res) => {
    await feeds.revokeFeed(deps, tenant(req), requestMeta(req));
    res.status(204).end();
  });
  return r;
}

const FEED_FILE = /^([A-Za-z0-9_-]{32,128})\.ics$/;

/** Public, cookie-less feed fetched by calendar apps. The token in the path is the only credential. */
export function icalRouter(deps: Deps): Router {
  const r = Router();
  r.use(
    rateLimit({
      windowMs: 60_000,
      limit: 120,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (_req, res) => {
        res.status(429).type('text/plain').send('Too many requests');
      },
    }),
  );
  r.get('/:file', async (req, res) => {
    const token = FEED_FILE.exec(req.params.file ?? '')?.[1];
    const body = token ? await feeds.renderFeed(deps, token) : null;
    if (body === null) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    res
      .status(200)
      .set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': 'inline; filename="lexforgex-hearings.ics"' })
      .send(body);
  });
  return r;
}
