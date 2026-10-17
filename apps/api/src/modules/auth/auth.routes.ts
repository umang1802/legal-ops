import {
  acceptInvitationSchema,
  forgotPasswordSchema,
  loginSchema,
  resetPasswordSchema,
  switchOrganizationSchema,
  verifyEmailSchema,
} from '@legalops/validation';
import { Router, type CookieOptions, type NextFunction, type Request, type Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import type { Deps } from '../../deps.js';
import { parse } from '../../http/validate.js';
import { requestMeta } from '../../middleware/request-context.js';
import { requireAuth } from '../../middleware/security.js';
import * as auth from './auth.service.js';

export const SESSION_COOKIE = 'lo_sid';

export type RateLimits = { loginPerWindow: number; resetPerWindow: number; windowMs: number };

function limiter(max: number, windowMs: number, keyFn?: (req: Request) => string) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // In-memory store: fine for a single API instance. Switch to a Redis store before scaling out.
    ...(keyFn ? { keyGenerator: keyFn } : {}),
    handler: (_req, res) => {
      res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many attempts. Please wait a few minutes and try again.',
        },
      });
    },
  });
}

function cookieOptions(deps: Deps, expires?: Date): CookieOptions {
  return {
    httpOnly: true,
    secure: deps.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    ...(expires ? { expires } : {}),
  };
}

/** Attaches req.auth when a valid session cookie is present. Never rejects; requireAuth does that. */
export function sessionLoader(deps: Deps) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const token: unknown = req.cookies?.[SESSION_COOKIE];
    if (typeof token === 'string' && token.length > 0 && token.length < 200) {
      const ctx = await auth.loadSession(deps, token);
      if (ctx) {
        req.auth = ctx;
        req.log = req.log.child({ userId: ctx.userId, organizationId: ctx.organizationId });
      }
    }
    next();
  };
}

export function authRouter(deps: Deps, limits: RateLimits): Router {
  const r = Router();
  // Per IP (IPv6 collapsed to its /56 so rotating addresses can't dodge the limit) + target email.
  const emailKey = (req: Request) =>
    `${ipKeyGenerator(req.ip ?? '')}:${typeof req.body?.email === 'string' ? req.body.email.toLowerCase() : ''}`;
  const loginLimiter = limiter(limits.loginPerWindow, limits.windowMs, emailKey);
  const resetLimiter = limiter(limits.resetPerWindow, limits.windowMs);

  r.post('/login', loginLimiter, async (req, res) => {
    const input = parse(loginSchema, req.body);
    const session = await auth.login(deps, input, requestMeta(req));
    res.cookie(
      SESSION_COOKIE,
      session.token,
      cookieOptions(deps, input.remember ? session.expiresAt : undefined),
    );
    res.json({ data: session.me });
  });

  r.post('/logout', requireAuth, async (req, res) => {
    await auth.logout(deps, req.auth!, requestMeta(req));
    res.clearCookie(SESSION_COOKIE, cookieOptions(deps));
    res.status(204).end();
  });

  r.get('/me', requireAuth, async (req, res) => {
    res.json({ data: await auth.getMe(deps, deps.pool, req.auth!.sessionId) });
  });

  r.post('/switch-organization', requireAuth, async (req, res) => {
    const { organizationId } = parse(switchOrganizationSchema, req.body);
    res.json({ data: await auth.switchOrganization(deps, req.auth!, organizationId, requestMeta(req)) });
  });

  r.post('/forgot-password', resetLimiter, async (req, res) => {
    const { email } = parse(forgotPasswordSchema, req.body);
    await auth.requestPasswordReset(deps, email, requestMeta(req));
    res.status(202).json({ data: { message: 'If that email is registered, a reset link is on its way.' } });
  });

  r.post('/reset-password', resetLimiter, async (req, res) => {
    const input = parse(resetPasswordSchema, req.body);
    await auth.resetPassword(deps, input, requestMeta(req));
    res.clearCookie(SESSION_COOKIE, cookieOptions(deps));
    res.status(204).end();
  });

  r.post('/verify-email', resetLimiter, async (req, res) => {
    const { token } = parse(verifyEmailSchema, req.body);
    await auth.verifyEmail(deps, token, requestMeta(req));
    res.status(204).end();
  });

  r.post('/invitations/accept', resetLimiter, async (req, res) => {
    const input = parse(acceptInvitationSchema, req.body);
    res.json({ data: await auth.acceptInvitation(deps, input, requestMeta(req)) });
  });

  return r;
}
