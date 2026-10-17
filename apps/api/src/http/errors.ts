import type { ApiErrorCode } from '@legalops/types';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown[],
  ) {
    super(message);
  }
}

export const unauthenticated = (message = 'Please sign in to continue') =>
  new AppError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = 'You do not have permission to do this') =>
  new AppError(403, 'FORBIDDEN', message);
export const notFound = (what = 'Record') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (message: string) => new AppError(409, 'CONFLICT', message);
export const validationError = (message: string, details?: unknown[]) =>
  new AppError(422, 'VALIDATION_ERROR', message, details);
