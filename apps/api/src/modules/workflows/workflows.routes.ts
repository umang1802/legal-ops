import { uuidSchema, workflowDryRunSchema, workflowSchema } from '@legalops/validation';
import { Router } from 'express';
import { z } from 'zod';
import type { Deps } from '../../deps.js';
import { parse } from '../../http/validate.js';
import { requestMeta } from '../../middleware/request-context.js';
import { requireAuth, requirePermission, tenant } from '../../middleware/security.js';
import * as workflows from './workflows.service.js';

export function workflowsRouter(deps: Deps): Router {
  const r = Router();
  r.use(requireAuth, requirePermission('workflows.manage'));

  r.get('/', async (req, res) => {
    res.json({ data: await workflows.listWorkflows(deps, tenant(req)) });
  });

  r.post('/', async (req, res) => {
    const input = parse(workflowSchema, req.body);
    res.status(201).json({ data: await workflows.createWorkflow(deps, tenant(req), input, requestMeta(req)) });
  });

  r.get('/:workflowId', async (req, res) => {
    const id = parse(uuidSchema, req.params.workflowId);
    res.json({ data: await workflows.getWorkflow(deps.pool, tenant(req), id) });
  });

  r.patch('/:workflowId', async (req, res) => {
    const id = parse(uuidSchema, req.params.workflowId);
    const input = parse(workflowSchema, req.body);
    res.json({ data: await workflows.updateWorkflow(deps, tenant(req), id, input, requestMeta(req)) });
  });

  r.post('/:workflowId/active', async (req, res) => {
    const id = parse(uuidSchema, req.params.workflowId);
    const { isActive } = parse(z.object({ isActive: z.boolean() }).strict(), req.body);
    res.json({ data: await workflows.setActive(deps, tenant(req), id, isActive, requestMeta(req)) });
  });

  r.post('/:workflowId/duplicate', async (req, res) => {
    const id = parse(uuidSchema, req.params.workflowId);
    res.status(201).json({ data: await workflows.duplicateWorkflow(deps, tenant(req), id, requestMeta(req)) });
  });

  r.post('/:workflowId/dry-run', async (req, res) => {
    const id = parse(uuidSchema, req.params.workflowId);
    const { targetId } = parse(workflowDryRunSchema, req.body);
    res.json({ data: await workflows.dryRun(deps, tenant(req), id, targetId) });
  });

  r.delete('/:workflowId', async (req, res) => {
    const id = parse(uuidSchema, req.params.workflowId);
    await workflows.deleteWorkflow(deps, tenant(req), id, requestMeta(req));
    res.status(204).end();
  });

  return r;
}
