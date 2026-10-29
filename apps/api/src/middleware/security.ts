import { timingSafeEqual } from 'node:crypto';
import type { FeatureKey, Permission } from '@legalops/types';
import { can, canWithFeatures, PERMISSION_FEATURE } from '@legalops/types';
import type { NextFunction, Request, Response } from 'express';
import { AppError, featureDisabled, forbidden, unauthenticated } from '../http/errors.js';
import type { TenantContext } from '../http/context.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Mutating requests must be JSON. A cross-site form/simple request cannot send application/json
 * without a CORS preflight, which our origin allowlist rejects. This also covers login CSRF.
 */
export function requireJson(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method) || req.method === 'DELETE') return next();
  if (!req.is('application/json')) {
    return next(new AppError(415, 'VALIDATION_ERROR', 'Content-Type must be application/json'));
  }
  next();
}

/** Double-submit check: authenticated mutations must echo the session's CSRF token in a header. */
export function csrfProtection(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method) || !req.auth) return next();
  const header = req.header('x-csrf-token') ?? '';
  const expected = Buffer.from(req.auth.csrfSecret);
  const actual = Buffer.from(header);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return next(
      new AppError(403, 'CSRF_INVALID', 'Your session token is out of date. Refresh and try again.'),
    );
  }
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.auth) return next(unauthenticated());
  next();
}

export function requirePermission(permission: Permission) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) return next(unauthenticated());
    if (!can(req.auth.role, permission)) return next(forbidden());
    const feature = PERMISSION_FEATURE[permission];
    if (feature && !req.auth.features.includes(feature)) return next(featureDisabled());
    next();
  };
}

/** Guards a switchable feature's routes: 404 FEATURE_DISABLED when it's off for the signed-in firm. */
export function requireFeature(feature: FeatureKey) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) return next(unauthenticated());
    if (!req.auth.features.includes(feature)) return next(featureDisabled());
    next();
  };
}

/** The role holds the permission and its feature (if any) is on. Use in services instead of `can`. */
export function allowed(ctx: TenantContext, permission: Permission): boolean {
  return canWithFeatures(ctx.role, ctx.features, permission);
}

export function tenant(req: Request): TenantContext {
  if (!req.auth) throw unauthenticated();
  const { userId, organizationId, role, features } = req.auth;
  return { userId, organizationId, role, features };
}

/** Passes when the role holds any one of the permissions (e.g. clerks record court fees without billing access). */
export function requireAnyPermission(...permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) return next(unauthenticated());
    if (!permissions.some((p) => can(req.auth!.role, p))) return next(forbidden());
    next();
  };
}
