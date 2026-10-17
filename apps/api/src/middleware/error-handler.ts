import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../http/errors.js';

type PgError = Error & { code?: string; constraint?: string };

function fromPg(err: PgError): AppError | undefined {
  switch (err.code) {
    case '23505':
      return new AppError(409, 'CONFLICT', 'This record already exists', [{ constraint: err.constraint }]);
    case '23514':
    case '23502':
      return new AppError(422, 'VALIDATION_ERROR', 'The change breaks a data rule', [
        { constraint: err.constraint },
      ]);
    case '23503':
      return new AppError(422, 'VALIDATION_ERROR', 'A referenced record does not exist', [
        { constraint: err.constraint },
      ]);
    case '23P01':
    case '23001':
      return new AppError(409, 'CONFLICT', 'This change is not allowed');
    default:
      return undefined;
  }
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  // body-parser errors (malformed JSON / too large) carry a status
  const status = (err as { status?: number }).status;
  if (!(err instanceof AppError) && status && status >= 400 && status < 500) {
    res.status(status).json({ error: { code: 'VALIDATION_ERROR', message: 'Malformed request body' } });
    return;
  }

  const appErr = err instanceof AppError ? err : fromPg(err as PgError);
  if (appErr) {
    if (appErr.status >= 500) req.log?.error({ err }, 'request failed');
    res.status(appErr.status).json({
      error: {
        code: appErr.code,
        message: appErr.message,
        ...(appErr.details ? { details: appErr.details } : {}),
      },
    });
    return;
  }

  req.log?.error({ err }, 'unhandled error');
  res
    .status(500)
    .json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' } });
}
