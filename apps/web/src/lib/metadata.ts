import type { MetadataListKey, MetadataOptionDto } from '@legalops/types';
import { useQuery } from '@tanstack/react-query';
import { api } from './api.js';

/** The firm's pick-list (Settings → Metadata), active and archived entries, in the firm's order. */
export function useMetadataOptions(list: MetadataListKey, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['metadata', list],
    queryFn: () => api.get<MetadataOptionDto[]>(`/metadata/${list}`),
    staleTime: 60_000,
    enabled: opts.enabled ?? true,
  });
}

/**
 * The names a form should offer: the active entries, plus the record's own value if it is no longer one of them (a hearing,
 * matter or expense saved before the firm tidied its list keeps showing, and keeping, its old value).
 */
export function optionNames(options: MetadataOptionDto[] | undefined, current?: string | null): string[] {
  const names = (options ?? []).filter((o) => o.isActive).map((o) => o.name);
  if (current && !names.some((n) => n.toLowerCase() === current.toLowerCase())) names.push(current);
  return names;
}
