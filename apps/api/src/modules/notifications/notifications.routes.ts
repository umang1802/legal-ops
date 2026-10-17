import { listNotificationsSchema, sendEmailSchema, uuidSchema } from '@legalops/validation';
import { Router } from 'express';
import type { Deps } from '../../deps.js';
import { parse } from '../../http/validate.js';
import { requestMeta } from '../../middleware/request-context.js';
import { requireAuth, requirePermission, tenant } from '../../middleware/security.js';
import * as notifications from './notifications.service.js';

/** Communication center (PRD Screen 17). Reading follows matter visibility; acting needs matters.edit. */
export function notificationsRouter(deps: Deps): Router {
  const r = Router();
  r.use(requireAuth);

  r.get('/', requirePermission('matters.view'), async (req, res) => {
    const f = parse(listNotificationsSchema, req.query);
    const { items, total } = await notifications.listNotifications(deps, tenant(req), f);
    res.json({ data: items, meta: { page: f.page, pageSize: f.pageSize, total } });
  });

  r.post('/send-email', requirePermission('matters.edit'), async (req, res) => {
    const input = parse(sendEmailSchema, req.body);
    res.status(201).json({ data: await notifications.sendManualEmail(deps, tenant(req), input, requestMeta(req)) });
  });

  r.get('/:notificationId', requirePermission('matters.view'), async (req, res) => {
    const id = parse(uuidSchema, req.params.notificationId);
    res.json({ data: await notifications.getNotification(deps, tenant(req), id) });
  });

  for (const [path, fn] of [
    ['approve', notifications.approveNotification],
    ['reject', notifications.rejectNotification],
    ['retry', notifications.retryNotification],
  ] as const) {
    r.post(`/:notificationId/${path}`, requirePermission('matters.edit'), async (req, res) => {
      const id = parse(uuidSchema, req.params.notificationId);
      res.json({ data: await fn(deps, tenant(req), id, requestMeta(req)) });
    });
  }

  return r;
}
