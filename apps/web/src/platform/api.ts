import type { ApiErrorCode } from '@legalops/types';
import { ApiError, type PageMeta } from '../lib/api.js';

/** Separate from the firm client: different base path and CSRF token, never shared. */
let csrfToken: string | null = null;
export const setPlatformCsrf = (t: string | null) => {
  csrfToken = t;
};

async function call<T>(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<{ data: T; meta?: PageMeta }> {
  let res: Response;
  try {
    res = await fetch(`/api/v1/platform${path}`, {
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
    throw new ApiError(0, 'NETWORK_ERROR', 'You appear to be offline.');
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
      json?.error?.message ?? 'Something went wrong.',
      json?.error?.details ?? [],
    );
  }
  return { data: json.data as T, ...(json.meta ? { meta: json.meta } : {}) };
}

export const platformApi = {
  get: async <T>(path: string) => (await call<T>('GET', path)).data,
  page: async <T>(path: string) => {
    const r = await call<T[]>('GET', path);
    return { items: r.data, meta: r.meta ?? { page: 1, pageSize: r.data.length, total: r.data.length } };
  },
  post: async <T>(path: string, body?: unknown) => (await call<T>('POST', path, body)).data,
  patch: async <T>(path: string, body?: unknown) => (await call<T>('PATCH', path, body)).data,
};
