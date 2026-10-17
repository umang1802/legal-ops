import {
  addMatterStaffSchema,
  createMatterSchema,
  listMattersSchema,
  paginationSchema,
  updateMatterSchema,
  uuidSchema,
} from '@legalops/validation';
import { Router } from 'express';
import type { Deps } from '../../deps.js';
import { parse } from '../../http/validate.js';
import { requestMeta } from '../../middleware/request-context.js';
import { requireAuth, requirePermission, tenant } from '../../middleware/security.js';
import { listMatterTimeline } from '../timeline/timeline.service.js';
import * as matters from './matters.service.js';

export function mattersRouter(deps: Deps): Router {
  const r = Router();
  r.use(requireAuth);

  r.get('/', requirePermission('matters.view'), async (req, res) => {
    const f = parse(listMattersSchema, req.query);
    const { items, total } = await matters.listMatters(deps, tenant(req), f);
    res.json({ data: items, meta: { page: f.page, pageSize: f.pageSize, total } });
  });

  r.post('/', requirePermission('matters.create'), async (req, res) => {
    const input = parse(createMatterSchema, req.body);
    res.status(201).json({ data: await matters.createMatter(deps, tenant(req), input, requestMeta(req)) });
  });

  r.get('/:matterId', requirePermission('matters.view'), async (req, res) => {
    const id = parse(uuidSchema, req.params.matterId);
    res.json({ data: await matters.getMatter(deps.pool, tenant(req), id) });
  });

  r.patch('/:matterId', requirePermission('matters.edit'), async (req, res) => {
    const id = parse(uuidSchema, req.params.matterId);
    const input = parse(updateMatterSchema, req.body);
    res.json({ data: await matters.updateMatter(deps, tenant(req), id, input, requestMeta(req)) });
  });

  r.post('/:matterId/staff', requirePermission('matters.edit'), async (req, res) => {
    const id = parse(uuidSchema, req.params.matterId);
    const input = parse(addMatterStaffSchema, req.body);
    res.json({ data: await matters.addMatterStaff(deps, tenant(req), id, input, requestMeta(req)) });
  });

  r.delete('/:matterId/staff/:userId', requirePermission('matters.edit'), async (req, res) => {
    const id = parse(uuidSchema, req.params.matterId);
    const userId = parse(uuidSchema, req.params.userId);
    await matters.removeMatterStaff(deps, tenant(req), id, userId, requestMeta(req));
    res.status(204).end();
  });

  r.get('/:matterId/timeline', requirePermission('matters.view'), async (req, res) => {
    const id = parse(uuidSchema, req.params.matterId);
    const page = parse(paginationSchema, req.query);
    const { items, total } = await listMatterTimeline(deps.pool, tenant(req), id, page);
    res.json({ data: items, meta: { page: page.page, pageSize: page.pageSize, total } });
  });

  return r;
}
