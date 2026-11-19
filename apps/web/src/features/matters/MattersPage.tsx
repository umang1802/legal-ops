import {
  MATTER_STATUS_LABELS,
  PRIORITY_LABELS,
  PRIORITIES,
  type ClientListItemDto,
  type CourtDto,
  type MatterListItemDto,
} from '@legalops/types';
import {
  Alert,
  Button,
  Card,
  Combobox,
  EmptyState,
  PageHeader,
  Pagination,
  SearchInput,
  SkeletonList,
  cn,
} from '@legalops/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Briefcase, Plus, SlidersHorizontal, X } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { api, qs } from '../../lib/api.js';
import { canAct, useSession } from '../../lib/auth.js';
import { fullName } from '../../lib/format.js';
import { useDebounced, useMembers } from '../../lib/hooks.js';
import { useMetadataOptions } from '../../lib/metadata.js';
import { MatterCard } from './MatterCard.js';

const STATUS_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'lead', label: MATTER_STATUS_LABELS.lead },
  { value: 'on_hold', label: MATTER_STATUS_LABELS.on_hold },
  { value: 'closed', label: MATTER_STATUS_LABELS.closed },
  { value: 'all', label: 'All' },
];

const HEARING_OPTIONS = [
  { value: 'week', label: 'Hearing in next 7 days' },
  { value: 'month', label: 'Hearing in next 30 days' },
  { value: 'none', label: 'No upcoming hearing' },
];

const PILL = 'h-9 rounded-full border border-line bg-surface px-3 text-sm';

/** A client search for the filter bar. The chosen client shows as a chip with a clear button (the Combobox's own). */
function ClientFilter({
  value,
  onChange,
}: {
  value: { id: string; name: string } | null;
  onChange: (c: { id: string; name: string } | null) => void;
}) {
  const [query, setQuery] = useState('');
  const q = useDebounced(query);
  const clients = useQuery({
    queryKey: ['clients', { q, filter: true }],
    queryFn: () => api.getPage<ClientListItemDto>(`/clients${qs({ search: q, pageSize: 10 })}`),
  });
  return (
    <Combobox
      label="Client"
      placeholder="Search by name, phone or email"
      value={value ? { value: value.id, label: value.name } : null}
      onChange={(o) => onChange(o ? { id: o.value, name: o.label } : null)}
      onQueryChange={setQuery}
      loading={clients.isFetching}
      options={(clients.data?.items ?? []).map((c) => ({
        value: c.id,
        label: c.name,
        description: [c.phone, c.email].filter(Boolean).join(' · ') || undefined,
      }))}
    />
  );
}

function CourtFilter({
  value,
  onChange,
}: {
  value: { id: string; name: string } | null;
  onChange: (c: { id: string; name: string } | null) => void;
}) {
  const [query, setQuery] = useState('');
  const q = useDebounced(query);
  const courts = useQuery({
    queryKey: ['courts', q],
    queryFn: () => api.get<CourtDto[]>(`/courts${qs({ search: q })}`),
    staleTime: 10 * 60_000,
  });
  return (
    <Combobox
      label="Court"
      placeholder="Search courts"
      value={value ? { value: value.id, label: value.name } : null}
      onChange={(o) => onChange(o ? { id: o.value, name: o.label } : null)}
      onQueryChange={setQuery}
      loading={courts.isFetching}
      options={(courts.data ?? []).map((c) => ({ value: c.id, label: c.name }))}
    />
  );
}

/** "Cases" in the nav: the matter list (a matter holds one or more court cases). */
export function MattersPage() {
  const me = useSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const q = useDebounced(search);
  const status = params.get('status') ?? 'open';
  const priority = params.get('priority') ?? '';
  const practiceArea = params.get('practiceArea') ?? '';
  const lawyerId = params.get('lawyerId') ?? '';
  const hearing = params.get('hearing') ?? '';
  const clientId = params.get('clientId') ?? '';
  const clientName = params.get('clientName') ?? '';
  const courtId = params.get('courtId') ?? '';
  const courtName = params.get('courtName') ?? '';
  const mine = params.get('mine') === '1';
  const page = Number(params.get('page') ?? '1');
  const seesAll = me.role === 'owner' || me.role === 'admin' || me.role === 'finance';

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };

  const practiceAreas = useMetadataOptions('practice_area');
  const members = useMembers();
  const moreFilters = [clientId, courtId].filter(Boolean).length;
  const [moreOpen, setMoreOpen] = useState(moreFilters > 0);
  const filtered = Boolean(
    q || status !== 'open' || priority || practiceArea || lawyerId || hearing || clientId || courtId || mine,
  );
  const clearAll = () => {
    setSearch('');
    setParams(new URLSearchParams(), { replace: true });
  };

  const list = useQuery({
    queryKey: [
      'matters',
      {
        q,
        status,
        priority,
        practiceArea,
        hearing,
        clientId,
        courtId,
        lawyer: mine ? me.user.id : lawyerId,
        page,
      },
    ],
    queryFn: () =>
      api.getPage<MatterListItemDto>(
        `/matters${qs({
          search: q,
          status,
          priority,
          practiceArea,
          hearing,
          clientId,
          courtId,
          lawyerId: mine ? me.user.id : lawyerId || undefined,
          page,
          pageSize: 25,
        })}`,
      ),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader
        title="Cases & matters"
        description={seesAll ? undefined : 'Matters you’re assigned to.'}
        actions={
          canAct(me, 'matters.create') ? (
            <Button icon={<Plus className="size-4" />} onClick={() => navigate('/matters/new')}>
              New matter
            </Button>
          ) : null
        }
      />
      <div className="mb-4 space-y-3">
        <SearchInput
          placeholder="Search title, client, case no. or CNR"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            set({ q: e.target.value || null });
          }}
          aria-label="Search matters"
        />
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Status"
            value={status}
            onChange={(e) => set({ status: e.target.value })}
            className={PILL}
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            aria-label="Priority"
            value={priority}
            onChange={(e) => set({ priority: e.target.value || null })}
            className={PILL}
          >
            <option value="">Any priority</option>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
          <select
            aria-label="Practice area"
            value={practiceArea}
            onChange={(e) => set({ practiceArea: e.target.value || null })}
            className={PILL}
          >
            <option value="">Any practice area</option>
            {/* Archived areas too: matters may still carry them. */}
            {(practiceAreas.data ?? []).map((a) => (
              <option key={a.id} value={a.name}>
                {a.name}
                {a.isActive ? '' : ' (archived)'}
              </option>
            ))}
          </select>
          <select
            aria-label="Next hearing"
            value={hearing}
            onChange={(e) => set({ hearing: e.target.value || null })}
            className={PILL}
          >
            <option value="">Any next hearing</option>
            {HEARING_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {seesAll ? (
            <select
              aria-label="Lawyer"
              value={mine ? '' : lawyerId}
              onChange={(e) => set({ lawyerId: e.target.value || null, mine: null })}
              className={PILL}
            >
              <option value="">Any lawyer</option>
              {(members.data ?? [])
                .filter((m) => m.status === 'active')
                .map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {fullName(m)}
                  </option>
                ))}
            </select>
          ) : null}
          {seesAll ? (
            <button
              type="button"
              aria-pressed={mine}
              onClick={() => set({ mine: mine ? null : '1', lawyerId: null })}
              className={cn(
                'h-9 rounded-full border px-3 text-sm font-medium',
                mine ? 'border-brand-700 bg-brand-700 text-white' : 'border-line bg-surface text-ink-soft',
              )}
            >
              My matters
            </button>
          ) : null}
          <button
            type="button"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((v) => !v)}
            className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-sm font-medium text-ink-soft"
          >
            <SlidersHorizontal className="size-4" aria-hidden />
            More filters{moreFilters ? ` (${moreFilters})` : ''}
          </button>
          {filtered ? (
            <button
              type="button"
              onClick={clearAll}
              className="inline-flex h-9 items-center gap-1 rounded-full px-3 text-sm font-medium text-brand-700 hover:bg-brand-50"
            >
              <X className="size-4" aria-hidden />
              Clear filters
            </button>
          ) : null}
        </div>
        {moreOpen ? (
          <div className="grid grid-cols-1 gap-3 rounded-xl border border-line bg-surface p-3 sm:grid-cols-2">
            <ClientFilter
              value={clientId ? { id: clientId, name: clientName || 'Selected client' } : null}
              onChange={(c) => set({ clientId: c?.id ?? null, clientName: c?.name ?? null })}
            />
            <CourtFilter
              value={courtId ? { id: courtId, name: courtName || 'Selected court' } : null}
              onChange={(c) => set({ courtId: c?.id ?? null, courtName: c?.name ?? null })}
            />
          </div>
        ) : null}
      </div>

      {list.isPending ? (
        <SkeletonList rows={5} />
      ) : list.isError ? (
        <Alert tone="danger">Couldn’t load matters. Check your connection and try again.</Alert>
      ) : list.data.items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Briefcase />}
            title={filtered ? 'No matters match these filters' : 'No open matters yet'}
            description={
              seesAll
                ? 'Create a matter to start tracking cases and hearings.'
                : 'Matters appear here once you’re assigned to one.'
            }
            action={
              canAct(me, 'matters.create') && !q ? (
                <Button onClick={() => navigate('/matters/new')}>New matter</Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <>
          <Card className={cn('divide-y divide-line', list.isFetching && 'opacity-70')}>
            {list.data.items.map((m) => (
              <MatterCard key={m.id} matter={m} />
            ))}
          </Card>
          <Pagination
            page={page}
            pageSize={list.data.meta.pageSize}
            total={list.data.meta.total}
            onPage={(p) => set({ page: String(p) })}
          />
        </>
      )}
    </>
  );
}
