import type { MemberDto } from '@legalops/types';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from './api.js';

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export const MEMBERS_KEY = ['organization', 'members'] as const;

export function useMembers() {
  return useQuery({
    queryKey: MEMBERS_KEY,
    queryFn: () => api.get<MemberDto[]>('/organization/members'),
    staleTime: 5 * 60_000,
  });
}
