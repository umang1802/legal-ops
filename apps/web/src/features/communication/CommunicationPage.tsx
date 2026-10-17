import type { NotificationDto } from '@legalops/types';
import { Alert, Card, EmptyState, PageHeader, Pagination, SkeletonList, Tabs } from '@legalops/ui';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { useState } from 'react';
import { api, qs } from '../../lib/api.js';
import { useSession } from '../../lib/auth.js';
import { NotificationSheet } from './NotificationSheet.js';
import { NotificationRow } from './shared.js';

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'awaiting_approval', label: 'Needs approval' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'sent', label: 'Sent' },
  { key: 'problem', label: 'Problems' },
  { key: 'skipped', label: 'Not sent' },
] as const;
type Filter = (typeof FILTERS)[number]['key'];

const EMPTY: Record<Filter, string> = {
  all: 'No messages yet',
  awaiting_approval: 'Nothing waiting for approval',
  scheduled: 'Nothing scheduled',
  sent: 'Nothing sent yet',
  problem: 'No delivery problems',
  skipped: 'Nothing was held back',
};

/** PRD Screen 17: every automated or manual message, what happened to it, and why. */
export function CommunicationPage() {
  const me = useSession();
  const [params, setParams] = useSearchParams();
  const status = (FILTERS.some((f) => f.key === params.get('status')) ? params.get('status') : 'all') as Filter;
  const page = Number(params.get('page') ?? 1) || 1;
  const [open, setOpen] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['notifications', { status, page }],
    queryFn: () => api.getPage<NotificationDto>(`/notifications${qs({ status, page, pageSize: 25 })}`),
  });
  const pending = useQuery({
    queryKey: ['notifications', { status: 'awaiting_approval', count: true }],
    queryFn: () => api.getPage<NotificationDto>(`/notifications${qs({ status: 'awaiting_approval', pageSize: 1 })}`),
  });
  const pendingCount = pending.data?.meta.total ?? 0;

  return (
    <div className="space-y-4">
      <PageHeader title="Communication" description="Every email LegalOps sent or will send, and why." />
      <Tabs
        label="Filter messages"
        items={FILTERS.map((f) => ({ ...f, badge: f.key === 'awaiting_approval' && pendingCount ? pendingCount : undefined }))}
        value={status}
        onChange={(k) => setParams(k === 'all' ? {} : { status: k })}
      />
      {list.isError ? <Alert tone="danger">Couldn’t load messages.</Alert> : null}
      <Card>
        {list.isPending ? (
          <SkeletonList rows={5} />
        ) : list.data && list.data.items.length ? (
          <div className="divide-y divide-line">
            {list.data.items.map((n) => (
              <NotificationRow key={n.id} n={n} timeZone={me.organization.timezone} onOpen={() => setOpen(n.id)} />
            ))}
          </div>
        ) : (
          <EmptyState title={EMPTY[status]} className="py-12" />
        )}
      </Card>
      {list.data && list.data.meta.total > list.data.meta.pageSize ? (
        <Pagination
          page={page}
          pageSize={list.data.meta.pageSize}
          total={list.data.meta.total}
          onPage={(p) => setParams({ ...(status !== 'all' ? { status } : {}), page: String(p) })}
        />
      ) : null}
      <NotificationSheet id={open} onClose={() => setOpen(null)} />
    </div>
  );
}
