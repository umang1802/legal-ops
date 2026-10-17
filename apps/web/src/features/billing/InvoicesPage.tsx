import { can, type InvoiceListItemDto } from '@legalops/types';
import {
  Alert,
  Button,
  Card,
  cn,
  EmptyState,
  PageHeader,
  Pagination,
  SearchInput,
  SkeletonList,
} from '@legalops/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { FilePlus2, Receipt } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { BillingNav } from './BillingNav.js';
import { api, qs } from '../../lib/api.js';
import { useSession } from '../../lib/auth.js';
import { useDebounced } from '../../lib/hooks.js';
import { InvoiceRow } from './InvoiceRow.js';

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Outstanding' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'partial', label: 'Part paid' },
  { key: 'paid', label: 'Paid' },
  { key: 'draft', label: 'Drafts' },
  { key: 'void', label: 'Void' },
] as const;

export function InvoicesPage() {
  const me = useSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'all';
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const q = useDebounced(search);
  const list = useQuery({
    queryKey: ['invoices', { status, q, page }],
    queryFn: () =>
      api.getPage<InvoiceListItemDto>(`/invoices${qs({ status, search: q, page, pageSize: 25 })}`),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <PageHeader
        title="Invoices"
        actions={
          can(me.role, 'invoices.manage') ? (
            <Button icon={<FilePlus2 className="size-4" />} onClick={() => navigate('/invoices/new')}>
              New invoice
            </Button>
          ) : null
        }
      />
      <BillingNav />
      <div className="mb-4 space-y-3">
        <SearchInput
          placeholder="Invoice number, client or matter"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          aria-label="Search invoices"
        />
        <div className="flex gap-2 overflow-x-auto">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={status === f.key}
              onClick={() => {
                setPage(1);
                setParams({ status: f.key }, { replace: true });
              }}
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
        <Alert tone="danger">Couldn’t load invoices.</Alert>
      ) : list.data.items.length === 0 ? (
        <Card>
          <EmptyState icon={<Receipt />} title="No invoices here" />
        </Card>
      ) : (
        <>
          <Card className={cn('divide-y divide-line', list.isFetching && 'opacity-70')}>
            {list.data.items.map((i) => (
              <InvoiceRow key={i.id} invoice={i} />
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
    </>
  );
}
