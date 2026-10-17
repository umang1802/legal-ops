import { can, type ClientListItemDto } from '@legalops/types';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Pagination,
  SearchInput,
  SkeletonList,
  cn,
} from '@legalops/ui';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Building2, ChevronRight, Plus, User, UsersRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api, qs } from '../../lib/api.js';
import { useSession } from '../../lib/auth.js';
import { useDebounced } from '../../lib/hooks.js';
import { ClientFormSheet } from './ClientFormSheet.js';

const STATUS_FILTERS = [
  { key: 'active', label: 'Active' },
  { key: 'inactive', label: 'Inactive' },
  { key: 'archived', label: 'Archived' },
  { key: 'all', label: 'All' },
] as const;

export function ClientsPage() {
  const me = useSession();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]['key']>('active');
  const [page, setPage] = useState(1);
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(params.get('new') === '1');
  // Quick add can target the page you're already on: react to ?new=1, not just the first render.
  useEffect(() => {
    if (params.get('new') === '1') setCreating(true);
  }, [params]);
  const q = useDebounced(search);

  const list = useQuery({
    queryKey: ['clients', { q, status, page }],
    queryFn: () => api.getPage<ClientListItemDto>(`/clients${qs({ search: q, status, page, pageSize: 25 })}`),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader
        title="Clients"
        actions={
          can(me.role, 'clients.create') ? (
            <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              New client
            </Button>
          ) : null
        }
      />
      <div className="mb-4 space-y-3">
        <SearchInput
          placeholder="Search name, email or phone"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          aria-label="Search clients"
        />
        <div className="flex gap-2 overflow-x-auto">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => {
                setStatus(f.key);
                setPage(1);
              }}
              aria-pressed={status === f.key}
              className={cn(
                'h-9 shrink-0 rounded-full border px-3 text-sm font-medium',
                status === f.key
                  ? 'border-brand-700 bg-brand-700 text-white'
                  : 'border-line bg-surface text-ink-soft',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {list.isPending ? (
        <SkeletonList rows={5} />
      ) : list.isError ? (
        <Alert tone="danger">Couldn’t load clients. Check your connection and try again.</Alert>
      ) : list.data.items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<UsersRound />}
            title={q ? `No clients match “${q}”` : 'No clients yet'}
            description={
              q ? 'Try a phone number or part of the email.' : 'Add your first client to open a matter.'
            }
            action={
              !q && can(me.role, 'clients.create') ? (
                <Button onClick={() => setCreating(true)}>Add client</Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <>
          <Card className={cn('divide-y divide-line', list.isFetching && 'opacity-70')}>
            {list.data.items.map((c) => (
              <Link
                key={c.id}
                to={`/clients/${c.id}`}
                className="flex items-center gap-3 px-4 py-3 hover:bg-subtle sm:px-5"
              >
                <div className="grid size-10 shrink-0 place-items-center rounded-full bg-subtle text-muted">
                  {c.clientType === 'company' ? (
                    <Building2 className="size-5" />
                  ) : (
                    <User className="size-5" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{c.name}</p>
                  <p className="truncate text-sm text-muted">
                    {[c.phone, c.email, c.city].filter(Boolean).join(' · ') || 'No contact details'}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {c.status !== 'active' ? (
                    <Badge>{c.status === 'archived' ? 'Archived' : 'Inactive'}</Badge>
                  ) : null}
                  {c.activeMatterCount > 0 ? (
                    <Badge tone="info">
                      {c.activeMatterCount} open matter{c.activeMatterCount === 1 ? '' : 's'}
                    </Badge>
                  ) : null}
                  <ChevronRight className="size-4 text-muted" aria-hidden />
                </div>
              </Link>
            ))}
          </Card>
          <Pagination
            page={page}
            pageSize={list.data.meta.pageSize}
            total={list.data.meta.total}
            onPage={setPage}
          />
        </>
      )}

      <ClientFormSheet
        open={creating}
        onClose={() => {
          setCreating(false);
          if (params.has('new')) setParams({}, { replace: true });
        }}
        onSaved={(c) => navigate(`/clients/${c.id}`)}
      />
    </>
  );
}
