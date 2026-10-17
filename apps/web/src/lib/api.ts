import type { ApiErrorCode } from '@legalops/types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | 'NETWORK_ERROR',
    message: string,
    readonly details: { path?: string; message?: string }[] = [],
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  return (await requestEnvelope<T>(method, path, body)).data;
}

export type PageMeta = { page: number; pageSize: number; total: number };

async function requestEnvelope<T>(
  method: Method,
  path: string,
  body?: unknown,
): Promise<{ data: T; meta?: PageMeta }> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      },
      ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}),
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'You appear to be offline. Check your connection and try again.');
  }
  if (res.status === 204) return { data: undefined as T };
  const json = (await res.json().catch(() => null)) as {
    data?: T;
    meta?: PageMeta;
    error?: { code: ApiErrorCode; message: string; details?: [] };
  } | null;
  if (!res.ok || !json || json.error) {
    throw new ApiError(
      res.status,
      json?.error?.code ?? 'INTERNAL_ERROR',
      json?.error?.message ?? 'Something went wrong. Please try again.',
      json?.error?.details ?? [],
    );
  }
  return { data: json.data as T, ...(json.meta ? { meta: json.meta } : {}) };
}

/** Builds a query string, dropping empty values. */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  getPage: async <T>(path: string) => {
    const env = await requestEnvelope<T[]>('GET', path);
    return {
      items: env.data,
      meta: env.meta ?? { page: 1, pageSize: env.data.length, total: env.data.length },
    };
  },
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};

/** Maps server field errors onto react-hook-form fields. Returns false when none matched. */
export function applyFieldErrors(
  err: unknown,
  setError: (name: never, error: { message: string }) => void,
): boolean {
  if (!(err instanceof ApiError) || err.details.length === 0) return false;
  let applied = false;
  for (const d of err.details) {
    if (d.path && d.message) {
      setError(d.path as never, { message: d.message });
      applied = true;
    }
  }
  return applied;
}
