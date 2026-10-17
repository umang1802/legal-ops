import { createClientSchema, listClientsSchema, updateClientSchema, uuidSchema } from '@legalops/validation';
import { Router } from 'express';
import type { Deps } from '../../deps.js';
import { parse } from '../../http/validate.js';
import { requestMeta } from '../../middleware/request-context.js';
import { requireAuth, requirePermission, tenant } from '../../middleware/security.js';
import * as clients from './clients.service.js';

export function clientsRouter(deps: Deps): Router {
  const r = Router();
  r.use(requireAuth);

  r.get('/', requirePermission('clients.view'), async (req, res) => {
    const f = parse(listClientsSchema, req.query);
    const { items, total } = await clients.listClients(deps, tenant(req), f);
    res.json({ data: items, meta: { page: f.page, pageSize: f.pageSize, total } });
  });

  r.post('/', requirePermission('clients.create'), async (req, res) => {
    const input = parse(createClientSchema, req.body);
    res.status(201).json({ data: await clients.createClient(deps, tenant(req), input, requestMeta(req)) });
  });

  r.get('/:clientId', requirePermission('clients.view'), async (req, res) => {
    const id = parse(uuidSchema, req.params.clientId);
    res.json({ data: await clients.getClient(deps, tenant(req), id) });
  });

  r.patch('/:clientId', requirePermission('clients.edit'), async (req, res) => {
    const id = parse(uuidSchema, req.params.clientId);
    const input = parse(updateClientSchema, req.body);
    res.json({ data: await clients.updateClient(deps, tenant(req), id, input, requestMeta(req)) });
  });

  r.delete('/:clientId', requirePermission('clients.edit'), async (req, res) => {
    const id = parse(uuidSchema, req.params.clientId);
    await clients.archiveClient(deps, tenant(req), id, requestMeta(req));
    res.status(204).end();
  });

  return r;
}
