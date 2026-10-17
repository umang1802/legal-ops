import type { ClientListItemDto, CourtDto, MatterListItemDto } from '@legalops/types';
import { Button, Combobox, type ComboOption } from '@legalops/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { api, ApiError, qs } from '../../lib/api.js';
import { useDebounced } from '../../lib/hooks.js';
import { ClientFormSheet } from '../clients/ClientFormSheet.js';

export function ClientPicker({
  value,
  onChange,
  error,
}: {
  value: ComboOption | null;
  onChange: (o: ComboOption | null) => void;
  error?: string | undefined;
}) {
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const q = useDebounced(query);
  const clients = useQuery({
    queryKey: ['clients', { q, status: 'active', page: 1, picker: true }],
    queryFn: () =>
      api.getPage<ClientListItemDto>(`/clients${qs({ search: q, status: 'active', pageSize: 10 })}`),
  });
  return (
    <>
      <Combobox
        label="Client"
        placeholder="Search by name, phone or email"
        value={value}
        onChange={onChange}
        onQueryChange={setQuery}
        loading={clients.isFetching}
        error={error}
        options={(clients.data?.items ?? []).map((c) => ({
          value: c.id,
          label: c.name,
          description: [c.phone, c.email].filter(Boolean).join(' · ') || undefined,
        }))}
        footer={
          <Button
            variant="ghost"
            size="sm"
            block
            icon={<Plus className="size-4" />}
            onClick={() => setCreating(true)}
          >
            New client{query ? ` “${query}”` : ''}
          </Button>
        }
      />
      <ClientFormSheet
        open={creating}
        onClose={() => setCreating(false)}
        defaultName={query}
        onSaved={(c) =>
          onChange({
            value: c.id,
            label: c.name,
            description: [c.phone, c.email].filter(Boolean).join(' · ') || undefined,
          })
        }
      />
    </>
  );
}

export function CourtPicker({
  value,
  onChange,
  error,
}: {
  value: ComboOption | null;
  onChange: (o: ComboOption | null) => void;
  error?: string | undefined;
}) {
  const qc = useQueryClient();
  const [query, setQuery] = useState('');
  const q = useDebounced(query);
  const courts = useQuery({
    queryKey: ['courts', q],
    queryFn: () => api.get<CourtDto[]>(`/courts${qs({ search: q })}`),
    staleTime: 10 * 60_000,
  });
  const add = useMutation({
    mutationFn: (name: string) => api.post<CourtDto>('/courts', { name }),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: ['courts'] });
      onChange({ value: c.id, label: c.name });
    },
  });
  return (
    <Combobox
      label="Court"
      placeholder="Search courts"
      value={value}
      onChange={onChange}
      onQueryChange={setQuery}
      loading={courts.isFetching || add.isPending}
      error={error ?? (add.error instanceof ApiError ? add.error.message : undefined)}
      emptyText="Not in the list yet"
      options={(courts.data ?? []).map((c) => ({
        value: c.id,
        label: c.name,
        description:
          [c.city, c.isGlobal ? null : 'Added by your firm'].filter(Boolean).join(' · ') || undefined,
      }))}
      footer={
        query.trim().length >= 2 ? (
          <Button
            variant="ghost"
            size="sm"
            block
            icon={<Plus className="size-4" />}
            onClick={() => add.mutate(query.trim())}
          >
            Add “{query.trim()}”
          </Button>
        ) : undefined
      }
    />
  );
}

export function MatterPicker({
  value,
  onChange,
  label = 'Matter (optional)',
}: {
  value: ComboOption | null;
  onChange: (o: ComboOption | null) => void;
  label?: string;
}) {
  const [query, setQuery] = useState('');
  const q = useDebounced(query);
  const matters = useQuery({
    queryKey: ['matters', { q, picker: true }],
    queryFn: () => api.getPage<MatterListItemDto>(`/matters${qs({ search: q, pageSize: 10 })}`),
  });
  return (
    <Combobox
      label={label}
      placeholder="Search matters"
      value={value}
      onChange={onChange}
      onQueryChange={setQuery}
      loading={matters.isFetching}
      options={(matters.data?.items ?? []).map((m) => ({
        value: m.id,
        label: m.title,
        description: m.client.name,
      }))}
    />
  );
}
