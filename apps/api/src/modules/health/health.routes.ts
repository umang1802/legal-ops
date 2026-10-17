import { Router } from 'express';
import type { Deps } from '../../deps.js';

export function healthRouter(deps: Deps): Router {
  const r = Router();
  r.get('/live', (_req, res) => {
    res.json({ data: { status: 'ok' } });
  });
  r.get('/ready', async (_req, res) => {
    try {
      await deps.pool.query('SELECT 1');
      res.json({ data: { status: 'ok', checks: { database: 'ok' } } });
    } catch {
      res.status(503).json({ data: { status: 'unavailable', checks: { database: 'down' } } });
    }
  });
  return r;
}
