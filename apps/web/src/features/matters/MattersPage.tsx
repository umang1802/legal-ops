import {
  can,
  MATTER_STATUS_LABELS,
  PRIORITY_LABELS,
  PRIORITIES,
  type MatterListItemDto,
} from '@legalops/types';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Pagination,
  SearchInput,
  SkeletonList,
  cn,
} from '@legalops/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Briefcase, Plus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { api, qs } from '../../lib/api.js';
import { useSession } from '../../lib/auth.js';
import { useDebounced } from '../../lib/hooks.js';
import { MatterCard } from './MatterCard.js';

const STATUS_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'lead', label: MATTER_STATUS_LABELS.lead },
  { value: 'on_hold', label: MATTER_STATUS_LABELS.on_hold },
  { value: 'closed', label: MATTER_STATUS_LABELS.closed },
  { value: 'all', label: 'All' },
];

/** "Cases" in the nav: the matter list (a matter holds one or more court cases). */
export function MattersPage() {
  const me = useSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const q = useDebounced(search);
  const status = params.get('status') ?? 'open';
  const priority = params.get('priority') ?? '';
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

  const list = useQuery({
    queryKey: ['matters', { q, status, priority, mine, page }],
    queryFn: () =>
      api.getPage<MatterListItemDto>(
        `/matters${qs({ search: q, status, priority, lawyerId: mine ? me.user.id : undefined, page, pageSize: 25 })}`,
      ),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader
        title="Cases & matters"
        description={seesAll ? undefined : 'Matters you’re assigned to.'}
        actions={
          can(me.role, 'matters.create') ? (
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
        <div className="flex flex-wrap gap-2">
          <select
            aria-label="Status"
            value={status}
            onChange={(e) => set({ status: e.target.value })}
            className="h-9 rounded-full border border-line bg-surface px-3 text-sm"
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
            className="h-9 rounded-full border border-line bg-surface px-3 text-sm"
          >
            <option value="">Any priority</option>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
          {seesAll ? (
            <button
              type="button"
              aria-pressed={mine}
              onClick={() => set({ mine: mine ? null : '1' })}
              className={cn(
                'h-9 rounded-full border px-3 text-sm font-medium',
                mine ? 'border-brand-700 bg-brand-700 text-white' : 'border-line bg-surface text-ink-soft',
              )}
            >
              My matters
            </button>
          ) : null}
        </div>
      </div>

      {list.isPending ? (
        <SkeletonList rows={5} />
      ) : list.isError ? (
        <Alert tone="danger">Couldn’t load matters. Check your connection and try again.</Alert>
      ) : list.data.items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Briefcase />}
            title={
              q || status !== 'open' || priority || mine
                ? 'No matters match these filters'
                : 'No open matters yet'
            }
            description={
              seesAll
                ? 'Create a matter to start tracking cases and hearings.'
                : 'Matters appear here once you’re assigned to one.'
            }
            action={
              can(me.role, 'matters.create') && !q ? (
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
