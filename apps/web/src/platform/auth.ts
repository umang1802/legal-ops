import type { PlatformMe } from '@legalops/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../lib/api.js';
import { platformApi, setPlatformCsrf } from './api.js';

export const PLATFORM_ME = ['platform', 'me'] as const;

export function usePlatformMe() {
  return useQuery({
    queryKey: PLATFORM_ME,
    queryFn: async () => {
      try {
        const me = await platformApi.get<PlatformMe>('/auth/me');
        setPlatformCsrf(me.csrfToken);
        return me;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          setPlatformCsrf(null);
          return null;
        }
        throw err;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

const useSetMe = () => {
  const qc = useQueryClient();
  return (me: PlatformMe | null) => {
    setPlatformCsrf(me?.csrfToken ?? null);
    qc.setQueryData(PLATFORM_ME, me);
  };
};

export function usePlatformLogin() {
  const setMe = useSetMe();
  return useMutation({
    mutationFn: (b: { email: string; password: string }) => platformApi.post<PlatformMe>('/auth/login', b),
    onSuccess: setMe,
  });
}
export function useStartEnrolment() {
  return useMutation({
    mutationFn: () => platformApi.post<{ secret: string; otpauthUrl: string }>('/auth/totp/enroll'),
  });
}
export function useVerifyCode() {
  const setMe = useSetMe();
  return useMutation({
    mutationFn: (code: string) => platformApi.post<PlatformMe>('/auth/totp/verify', { code }),
    onSuccess: setMe,
  });
}
export function usePlatformLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => platformApi.post<void>('/auth/logout'),
    onSettled: () => {
      setPlatformCsrf(null);
      qc.removeQueries({ queryKey: ['platform'] });
      qc.setQueryData(PLATFORM_ME, null);
    },
  });
}
