import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { RequestMeta } from '../http/context.js';

const REQUEST_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  req.requestId = incoming && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-request-id', req.requestId);
  next();
}

export function requestMeta(req: Request): RequestMeta {
  return { requestId: req.requestId, ip: req.ip ?? null, userAgent: req.header('user-agent') ?? null };
}
