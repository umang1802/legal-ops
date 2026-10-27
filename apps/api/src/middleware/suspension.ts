import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../http/errors.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
/**
 * Writes a suspended firm's users may still make: leaving, moving to another firm, and the
 * token-authenticated account flows, which act on a person rather than the suspended firm.
 */
const ALLOWED = new Set([
  'POST /auth/logout',
  'POST /auth/switch-organization',
  'POST /auth/login',
  'POST /auth/forgot-password',
  'POST /auth/reset-password',
  'POST /auth/verify-email',
  'POST /auth/invitations/accept',
]);

/**
 * Suspended firms are read-only (L-12). Mounted on the firm router before every sub-router, so it
 * covers every route, including ones added later, by construction.
 */
export function blockWritesWhenSuspended(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE.has(req.method) || req.auth?.orgStatus !== 'suspended') return next();
  if (ALLOWED.has(`${req.method} ${req.path}`)) return next();
  next(new AppError(403, 'FIRM_SUSPENDED', 'This account is suspended, so changes can’t be saved. Contact LexForgeX.'));
}
