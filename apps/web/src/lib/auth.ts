import { allowedWhileSuspended, can, type MeResponse, type Permission } from '@legalops/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, setCsrfToken } from './api.js';

export const ME_KEY = ['me'] as const;

export function useMe() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: async () => {
      try {
        const me = await api.get<MeResponse>('/auth/me');
        setCsrfToken(me.csrfToken);
        return me;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          setCsrfToken(null);
          return null;
        }
        throw err;
      }
    },
    staleTime: 5 * 60_000,
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
  });
}

/** Current user; only call inside routes guarded by RequireAuth. */
export function useSession(): MeResponse {
  const { data } = useMe();
  if (!data) throw new Error('useSession used outside an authenticated route');
  return data;
}

/**
 * Permission check for UI controls. A suspended firm keeps read access only, so every
 * create/edit control gated through here disappears. Use this rather than `can(me.role, …)`.
 */
export function canAct(me: MeResponse, permission: Permission): boolean {
  if (me.organization.status === 'suspended' && !allowedWhileSuspended(permission)) return false;
  return can(me.role, permission);
}

export function useCan(permission: Permission): boolean {
  const { data } = useMe();
  return data ? canAct(data, permission) : false;
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string; remember?: boolean }) =>
      api.post<MeResponse>('/auth/login', input),
    onSuccess: (me) => {
      setCsrfToken(me.csrfToken);
      qc.setQueryData(ME_KEY, me);
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<void>('/auth/logout'),
    onSettled: () => {
      setCsrfToken(null);
      qc.clear();
      qc.setQueryData(ME_KEY, null);
    },
  });
}

export function useSwitchOrganization() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (organizationId: string) =>
      api.post<MeResponse>('/auth/switch-organization', { organizationId }),
    onSuccess: (me) => {
      setCsrfToken(me.csrfToken);
      qc.clear();
      qc.setQueryData(ME_KEY, me);
    },
  });
}
