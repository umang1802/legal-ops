import { AGING_BUCKETS, type AgingBucket, type InvoiceListItemDto } from '@legalops/types';
import { Alert, Card, EmptyState, PageHeader, SkeletonList, Tabs } from '@legalops/ui';
import { fromPaise, toPaise } from '@legalops/validation';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { BillingNav } from './BillingNav.js';
import { api, qs } from '../../lib/api.js';
import { formatINR } from '../../lib/money.js';
import { InvoiceRow } from './InvoiceRow.js';

type Tab = 'all' | AgingBucket;

/** PRD Screen 20. Reminder sending arrives with email in Phase 5. */
export function CollectionsPage() {
  const [params, setParams] = useSearchParams();
  const tab = (AGING_BUCKETS.find((b) => b === params.get('bucket')) ?? 'all') as Tab;
  const list = useQuery({
    queryKey: ['billing', 'aging', tab],
    queryFn: () =>
      api.get<InvoiceListItemDto[]>(`/billing/aging${qs({ bucket: tab === 'all' ? undefined : tab })}`),
  });
  const totalPaise = (list.data ?? []).reduce((s, i) => s + toPaise(i.amountDue), 0);
  return (
    <>
      <PageHeader
        title="Collections"
        description="Overdue invoices by age. Automatic reminders arrive with email (Phase 5)."
      />
      <BillingNav />
      <div className="mb-4">
        <Tabs
          label="Aging"
          items={[
            { key: 'all', label: 'All overdue' },
            ...AGING_BUCKETS.map((b) => ({ key: b, label: `${b} days` })),
          ]}
          value={tab}
          onChange={(k) => setParams(k === 'all' ? {} : { bucket: k }, { replace: true })}
        />
      </div>
      {list.isPending ? (
        <SkeletonList rows={4} />
      ) : list.isError ? (
        <Alert tone="danger">Couldn’t load collections.</Alert>
      ) : list.data.length === 0 ? (
        <Card>
          <EmptyState icon={<CheckCircle2 />} title="Nothing overdue here" />
        </Card>
      ) : (
        <>
          <p className="mb-2 text-sm text-muted">
            {list.data.length} invoice{list.data.length === 1 ? '' : 's'} · {formatINR(fromPaise(totalPaise))}{' '}
            overdue
          </p>
          <Card className="divide-y divide-line">
            {[...list.data]
              .sort((a, b) => b.daysOverdue - a.daysOverdue)
              .map((i) => (
                <InvoiceRow key={i.id} invoice={i} />
              ))}
          </Card>
        </>
      )}
    </>
  );
}
