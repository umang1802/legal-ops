import { templatePreviewSchema, templateSchema, uuidSchema } from '@legalops/validation';
import { Router } from 'express';
import { z } from 'zod';
import type { Deps } from '../../deps.js';
import { parse } from '../../http/validate.js';
import { requestMeta } from '../../middleware/request-context.js';
import { requireAuth, requirePermission, tenant } from '../../middleware/security.js';
import * as templates from './templates.service.js';

export function templatesRouter(deps: Deps): Router {
  const r = Router();
  r.use(requireAuth, requirePermission('templates.manage'));

  r.get('/', async (req, res) => {
    res.json({ data: await templates.listTemplates(deps, tenant(req)) });
  });

  r.post('/', async (req, res) => {
    const input = parse(templateSchema, req.body);
    res.status(201).json({ data: await templates.saveTemplate(deps, tenant(req), input, requestMeta(req)) });
  });

  r.post('/preview', async (req, res) => {
    const input = parse(templatePreviewSchema, req.body);
    res.json({ data: await templates.previewTemplate(deps, tenant(req), input) });
  });

  r.get('/:templateId', async (req, res) => {
    const id = parse(uuidSchema, req.params.templateId);
    res.json({ data: await templates.getTemplate(deps, tenant(req), id) });
  });

  r.patch('/:templateId', async (req, res) => {
    const id = parse(uuidSchema, req.params.templateId);
    const input = parse(templateSchema, req.body);
    res.json({ data: await templates.saveTemplate(deps, tenant(req), input, requestMeta(req), id) });
  });

  r.post('/:templateId/test-send', async (req, res) => {
    const id = parse(uuidSchema, req.params.templateId);
    const { matterId } = parse(z.object({ matterId: uuidSchema.optional() }).strict(), req.body ?? {});
    res.status(201).json({ data: await templates.testSendTemplate(deps, tenant(req), id, matterId, requestMeta(req)) });
  });

  r.delete('/:templateId', async (req, res) => {
    const id = parse(uuidSchema, req.params.templateId);
    await templates.deleteTemplate(deps, tenant(req), id, requestMeta(req));
    res.status(204).end();
  });

  return r;
}
