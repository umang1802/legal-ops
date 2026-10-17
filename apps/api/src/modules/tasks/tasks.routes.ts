import {
  createTaskSchema,
  listTasksSchema,
  reassignTaskSchema,
  taskCommentSchema,
  updateTaskSchema,
  uuidSchema,
} from '@legalops/validation';
import { Router } from 'express';
import type { Deps } from '../../deps.js';
import { parse } from '../../http/validate.js';
import { requestMeta } from '../../middleware/request-context.js';
import { requireAuth, requirePermission, tenant } from '../../middleware/security.js';
import * as tasks from './tasks.service.js';

/**
 * Viewing needs dashboard.view (everyone): visibility is enforced per task. Creating/reassigning needs
 * tasks.manage. Updating/completing is allowed for tasks.manage or the task's own assignee (checked in service).
 */
export function tasksRouter(deps: Deps): Router {
  const r = Router();
  r.use(requireAuth);

  r.get('/', requirePermission('dashboard.view'), async (req, res) => {
    const f = parse(listTasksSchema, req.query);
    const { items, total } = await tasks.listTasks(deps, tenant(req), f);
    res.json({ data: items, meta: { page: f.page, pageSize: f.pageSize, total } });
  });

  r.post('/', requirePermission('tasks.manage'), async (req, res) => {
    const input = parse(createTaskSchema, req.body);
    res.status(201).json({ data: await tasks.createTask(deps, tenant(req), input, requestMeta(req)) });
  });

  r.get('/:taskId', requirePermission('dashboard.view'), async (req, res) => {
    const id = parse(uuidSchema, req.params.taskId);
    res.json({ data: await tasks.getTask(deps.pool, tenant(req), id) });
  });

  r.patch('/:taskId', requirePermission('dashboard.view'), async (req, res) => {
    const id = parse(uuidSchema, req.params.taskId);
    const input = parse(updateTaskSchema, req.body);
    res.json({ data: await tasks.updateTask(deps, tenant(req), id, input, requestMeta(req)) });
  });

  r.post('/:taskId/complete', requirePermission('dashboard.view'), async (req, res) => {
    const id = parse(uuidSchema, req.params.taskId);
    res.json({ data: await tasks.completeTask(deps, tenant(req), id, requestMeta(req)) });
  });

  r.post('/:taskId/reassign', requirePermission('tasks.manage'), async (req, res) => {
    const id = parse(uuidSchema, req.params.taskId);
    const { assigneeId } = parse(reassignTaskSchema, req.body);
    res.json({ data: await tasks.reassignTask(deps, tenant(req), id, assigneeId, requestMeta(req)) });
  });

  r.get('/:taskId/comments', requirePermission('dashboard.view'), async (req, res) => {
    const id = parse(uuidSchema, req.params.taskId);
    res.json({ data: await tasks.listComments(deps, tenant(req), id) });
  });

  r.post('/:taskId/comments', requirePermission('dashboard.view'), async (req, res) => {
    const id = parse(uuidSchema, req.params.taskId);
    const { body } = parse(taskCommentSchema, req.body);
    res.status(201).json({ data: await tasks.addComment(deps, tenant(req), id, body, requestMeta(req)) });
  });

  return r;
}
