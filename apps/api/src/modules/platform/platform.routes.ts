import { timingSafeEqual } from 'node:crypto';
import {
  firmNotesSchema,
  inviteFirmSchema,
  listFirmsSchema,
  listPlatformAuditSchema,
  platformLoginSchema,
  reinviteFirmSchema,
  suspendFirmSchema,
  totpCodeSchema,
  uuidSchema,
} from '@legalops/validation';
import { Router, type CookieOptions, type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Deps } from '../../deps.js';
import type { PlatformAuth } from '../../http/context.js';
import { AppError, unauthenticated } from '../../http/errors.js';
import { parse } from '../../http/validate.js';
import { requestMeta } from '../../middleware/request-context.js';
import { requireJson } from '../../middleware/security.js';
import type { RateLimits } from '../auth/auth.routes.js';
import * as platformAuth from './platform-auth.service.js';
import * as firms from './platform-firms.service.js';

export const PLATFORM_COOKIE = 'lf_psid';
const COOKIE_PATH = '/api/v1/platform';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

function cookieOptions(deps: Deps, expires?: Date): CookieOptions {
  return { httpOnly: true, secure: deps.env.NODE_ENV === 'production', sameSite: 'strict', path: COOKIE_PATH, ...(expires ? { expires } : {}) };
}

function limiter(max: number, windowMs: number) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please wait a few minutes and try again.' } });
    },
  });
}

/** Reads only the platform cookie. The firm cookie is never consulted here. */
function platformSessionLoader(deps: Deps) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const token: unknown = req.cookies?.[PLATFORM_COOKIE];
    if (typeof token === 'string' && token.length > 0 && token.length < 200) {
      const ctx = await platformAuth.loadPlatformSession(deps, token);
      if (ctx) req.platform = ctx;
    }
    next();
  };
}

function platformCsrf(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE.has(req.method) || !req.platform) return next();
  const expected = Buffer.from(req.platform.csrfSecret);
  const actual = Buffer.from(req.header('x-csrf-token') ?? '');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return next(new AppError(403, 'CSRF_INVALID', 'Your session token is out of date. Refresh and try again.'));
  }
  next();
}

function requirePlatformSession(req: Request, _res: Response, next: NextFunction): void {
  if (!req.platform) return next(unauthenticated());
  next();
}

export function requirePlatformMfa(req: Request, _res: Response, next: NextFunction): void {
  if (!req.platform) return next(unauthenticated());
  if (!req.platform.mfaVerified) return next(new AppError(401, 'MFA_REQUIRED', 'Enter your two-factor code to continue'));
  next();
}

export function platformCtx(req: Request): PlatformAuth {
  if (!req.platform?.mfaVerified) throw unauthenticated();
  return req.platform;
}

export function platformRouter(deps: Deps, limits: RateLimits): Router {
  const r = Router();
  r.use(requireJson, platformSessionLoader(deps), platformCsrf);

  r.post('/auth/login', limiter(limits.loginPerWindow, limits.windowMs), async (req, res) => {
    const input = parse(platformLoginSchema, req.body);
    const { token, expiresAt, me } = await platformAuth.platformLogin(deps, input, requestMeta(req));
    res.cookie(PLATFORM_COOKIE, token, cookieOptions(deps, expiresAt));
    res.json({ data: me });
  });
  r.post('/auth/totp/enroll', requirePlatformSession, async (req, res) => {
    res.json({ data: await platformAuth.startTotpEnrolment(deps, req.platform!) });
  });
  r.post('/auth/totp/verify', limiter(limits.loginPerWindow, limits.windowMs), requirePlatformSession, async (req, res) => {
    const { code } = parse(totpCodeSchema, req.body);
    res.json({ data: await platformAuth.confirmTotp(deps, req.platform!, code, requestMeta(req)) });
  });
  r.get('/auth/me', requirePlatformSession, async (req, res) => {
    res.json({ data: await platformAuth.getPlatformMe(deps, req.platform!.sessionId) });
  });
  r.post('/auth/logout', requirePlatformSession, async (req, res) => {
    await platformAuth.platformLogout(deps, req.platform!);
    res.clearCookie(PLATFORM_COOKIE, cookieOptions(deps));
    res.status(204).end();
  });

  // Everything else needs a fully verified (password + TOTP) session.
  r.use(requirePlatformMfa);

  r.get('/firms', async (req, res) => {
    const f = parse(listFirmsSchema, req.query);
    const { items, meta } = await firms.listFirms(deps, f);
    res.json({ data: items, meta });
  });
  r.post('/firms', async (req, res) => {
    const input = parse(inviteFirmSchema, req.body);
    res.status(201).json({ data: await firms.inviteFirm(deps, platformCtx(req), input, requestMeta(req)) });
  });
  r.get('/firms/:firmId', async (req, res) => {
    res.json({ data: await firms.getFirm(deps.pool, parse(uuidSchema, req.params.firmId)) });
  });
  r.patch('/firms/:firmId', async (req, res) => {
    const { platformNotes } = parse(firmNotesSchema, req.body);
    res.json({ data: await firms.updateNotes(deps, platformCtx(req), parse(uuidSchema, req.params.firmId), platformNotes, requestMeta(req)) });
  });
  r.post('/firms/:firmId/suspend', async (req, res) => {
    const { reason } = parse(suspendFirmSchema, req.body);
    res.json({ data: await firms.suspendFirm(deps, platformCtx(req), parse(uuidSchema, req.params.firmId), reason, requestMeta(req)) });
  });
  r.post('/firms/:firmId/reactivate', async (req, res) => {
    res.json({ data: await firms.reactivateFirm(deps, platformCtx(req), parse(uuidSchema, req.params.firmId), requestMeta(req)) });
  });
  r.post('/firms/:firmId/invitation/resend', async (req, res) => {
    res.json({ data: await firms.resendInvite(deps, platformCtx(req), parse(uuidSchema, req.params.firmId), requestMeta(req)) });
  });
  r.post('/firms/:firmId/invitation/revoke', async (req, res) => {
    res.json({ data: await firms.revokeInvite(deps, platformCtx(req), parse(uuidSchema, req.params.firmId), requestMeta(req)) });
  });
  r.post('/firms/:firmId/invitation', async (req, res) => {
    const input = parse(reinviteFirmSchema, req.body);
    res.json({ data: await firms.reinviteFirm(deps, platformCtx(req), parse(uuidSchema, req.params.firmId), input, requestMeta(req)) });
  });
  r.get('/firms/:firmId/invitations', async (req, res) => {
    res.json({ data: await firms.listPendingInvitations(deps.pool, parse(uuidSchema, req.params.firmId)) });
  });
  r.post('/firms/:firmId/invitations/:invitationId/link', async (req, res) => {
    const data = await firms.issueInviteLink(
      deps,
      platformCtx(req),
      parse(uuidSchema, req.params.firmId),
      parse(uuidSchema, req.params.invitationId),
      requestMeta(req),
    );
    // The link is a credential: never cache it anywhere between here and the admin's screen.
    res.set('Cache-Control', 'no-store').json({ data });
  });
  r.get('/audit-logs', async (req, res) => {
    const { items, meta } = await firms.listPlatformAudit(deps.pool, parse(listPlatformAuditSchema, req.query));
    res.json({ data: items, meta });
  });

  // Never fall through into the firm router.
  r.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });
  return r;
}
